# `dpc-self-service-portal` Module — Comprehensive Documentation

This documents a **separate Terraform module/system**, also called `dpc-self-service-portal`, distinct from the two stacks (`terraform/` org, `terraform-personal/` personal) documented elsewhere in this project. It shares the same DynamoDB-backed request/promotion design, but packages it differently — notably, it owns and deploys the frontend hosting itself (S3 + CloudFront), which neither of the other two stacks does.

This is deliberately kept **separate from the [Operational Runbook](./dpc-self-service-portal-operational-runbook.md)** for this same module — that document covers deploying, monitoring, and what to check before this goes to production; this one covers how it's built.

Built entirely from the Terraform source provided for review in this project — no live deployment of this module and no application code for its two Lambdas was available to verify against. Anywhere a detail depends on `handler.py` internals rather than the `.tf` file, that's called out explicitly rather than assumed to match the org/personal stacks' Lambdas.

## Contents

1. [How this differs from the org/personal stacks](#1-how-this-differs-from-the-orgpersonal-stacks)
2. [Architecture](#2-architecture)
3. [Frontend hosting design (S3 + CloudFront)](#3-frontend-hosting-design-s3--cloudfront)
4. [API Gateway routes](#4-api-gateway-routes)
5. [DynamoDB schema](#5-dynamodb-schema)
6. [Lambdas](#6-lambdas)
7. [IAM, secrets, and email](#7-iam-secrets-and-email)
8. [Resilience: DLQ + retry sweep](#8-resilience-dlq--retry-sweep)

## 1. How this differs from the org/personal stacks

| | `dpc-self-service-portal` module | org / personal stacks |
|---|---|---|
| Frontend hosting | **Managed by this module** — S3 bucket + CloudFront distribution + Origin Access Control | Not managed by Terraform at all; built and hosted separately |
| API Gateway stage | Named stage `dpc`, `auto_deploy = true` | `$default` stage |
| Observability | New Relic Lambda layer + extension on both functions (env vars: `NEW_RELIC_ACCOUNT_ID`, `NEW_RELIC_LICENSE_KEY`, `NEW_RELIC_LAMBDA_HANDLER=lambda_function.lambda_handler`, extension log-forwarding flags) | Plain CloudWatch Logs only, no APM layer |
| Lambda sizing | 1024MB / 900s timeout on **both** functions | Main: 256MB/29s, GitOps: 256MB/240s (deliberately different, sized per function's job) |
| Source control host | Not specified in this snippet — only a single `bitbucket` secret resource, no Bitbucket/GitHub-specific env vars beyond `BITBUCKET_URL`/`PROJECT_KEY`/`REPO_NAME` | Bitbucket Server (org) or GitHub (personal) |
| DLQ + sweep | Same design (SQS DLQ + EventBridge `rate(10 minutes)` sweep), gated behind `enable_gitops_dlq` | Identical mechanism |

## 2. Architecture

```mermaid
flowchart TB
    Dev["Developer's machine\n(local npm run build)"] -->|aws s3 sync/cp| S3[S3 bucket: frontend]
    User[Browser] -->|HTTPS| CF[CloudFront distribution]
    CF -->|OAC-signed request| S3
    User -->|HTTPS, API calls| APIGW["API Gateway HTTP API\n(stage: dpc)"]
    APIGW --> MainLambda["Lambda: main\n(New Relic instrumented)"]
    MainLambda <--> DDB[(DynamoDB: requests)]
    MainLambda -- invoke --> GitopsLambda["Lambda: gitops\n(New Relic instrumented)"]
    GitopsLambda <--> DDB
    GitopsLambda --> SM[Secrets Manager: bitbucket secret]
    GitopsLambda --> SES[Amazon SES]
    GitHost[Git host] -->|webhook| APIGW
    EventBridge["EventBridge rule\nrate(10 min)"] -->|action: SWEEP| GitopsLambda
    GitopsLambda -.on exhausted retries.-> DLQ[(SQS DLQ, optional)]
```

The request/promotion model (DynamoDB-backed market locks, promotion locks, webhook-driven status advancement) is the same design documented in depth for the org/personal stacks — see the [Comprehensive Documentation](./portal-comprehensive-documentation.md) for that shared design's internals. This document focuses on what's specific to this module: the frontend hosting it owns, and the infrastructure differences noted above.

## 3. Frontend hosting design (S3 + CloudFront)

The frontend is **not built by Terraform** — it's built locally and pushed to the S3 bucket this module provisions as a separate step outside this Terraform run (deployment mechanics are in the [Operational Runbook](./dpc-self-service-portal-operational-runbook.md#deploying-a-frontend-update)). This module's job is purely to provision and wire together the hosting:

- **`aws_s3_bucket.frontend`** — private bucket (`${var.project_name}-${var.environment}-frontend`); `aws_s3_bucket_public_access_block` blocks all four public-access vectors, so nothing in this bucket is ever reachable directly, only through CloudFront.
- **`aws_cloudfront_origin_access_control.frontend`** — SigV4-signed OAC (the modern replacement for the older Origin Access Identity), so CloudFront's requests to S3 are authenticated as CloudFront itself.
- **`aws_cloudfront_distribution.frontend`** — single S3 origin, HTTPS-only to viewers (`redirect-to-https`), GET/HEAD/OPTIONS only, compression on. `custom_error_response` maps both 403 and 404 back to `/index.html` with a `200` — the standard SPA pattern so client-side routing (React Router) works on a hard refresh or a direct link to a deep route, since S3/CloudFront otherwise has no concept of those routes existing.
- **`aws_s3_bucket_policy.frontend`** — grants `s3:GetObject` to the CloudFront service principal only, conditioned (`AWS:SourceArn`) to this specific distribution, so no other CloudFront distribution in the account (or anyone else) can read from the bucket even if they discovered its name.
- **Cache behavior**: no explicit `min_ttl`/`default_ttl`/`max_ttl` is set, so CloudFront falls back to its own defaults (24 hours default/max TTL under the legacy `forwarded_values` cache-behavior style used here). The operational implication of this (cache invalidation discipline on every deploy) is covered in the runbook.

## 4. API Gateway routes

All routes are on the `dpc` stage (so the full path is `<api-invoke-url>/dpc/<route>`), `AWS_PROXY` into the `main` Lambda:

| Route | Purpose |
|---|---|
| `POST /request` | Submit a new whitelist request |
| `GET /listrequests` | List requests |
| `GET /requests/{request_id}` | Request detail |
| `GET /whitelist/{market_code}/{environment}` | Live whitelist read |
| `POST /requests/{request_id}/release-lock` | Admin: force-release a market lock |
| `POST /requests/{request_id}/retry-promotion` | Admin: force-retry a stuck promotion |
| `POST /bitbucket/webhook` | Inbound webhook from the git host |

This matches the route set (and, functionally, the `/dpc/...` path shape once the stage name is included) documented for the org/personal stacks' Main Lambda — the request/response payload shapes there are a reasonable guide to what this Lambda likely expects, but **that's an inference from the shared design, not something confirmed against this module's own `handler.py`**, which wasn't provided here.

CORS is configured at the API level (`cors_configuration` block) rather than per-response in Lambda code — allowed origin is exactly the CloudFront distribution's own domain, so the frontend this module deploys is the only origin permitted to call this API out of the box.

## 5. DynamoDB schema

Same table design as the other two stacks: hash key `request_id`, GSIs `submitted-by-created-at` (hash `submitted_by_id`, range `createdAt`) and `market-code-created-at` (hash `market_code`, range `createdAt`), point-in-time recovery and encryption both on.

One naming detail worth flagging here at the source: the table name is `${var.project_name}-requests` — **no `${var.environment}` suffix**, unlike the frontend S3 bucket's name (`${var.project_name}-${var.environment}-frontend`). Same is true of the Lambda function names, IAM role/policy names, and the API name — none include `${var.environment}`. The deployment-risk implication of this (collisions if deployed twice into one account) is covered in the runbook's pre-production checklist.

## 6. Lambdas

Both `main` and `gitops` run `python${var.lambda_python_runtime}`, 1024MB, 900s (15 minute) timeout, with the AWS Lambda Powertools layer and a New Relic layer attached. Both set `handler = var.newrelic_lambda_handler` and `NEW_RELIC_LAMBDA_HANDLER = "lambda_function.lambda_handler"` — the New Relic layer wraps the real handler for tracing/metrics, then delegates to `lambda_function.lambda_handler` as the actual entry point.

Both functions currently share the same deployment package (`filename = var.lambda_filename`, one variable used for both). If `main` and `gitops` are meant to be two different codebases (as they are in the org/personal stacks — request-handling logic vs. git-host integration logic are quite different concerns), this is worth double-checking with whoever owns the build: either they're genuinely built from one combined package with the New Relic wrapper routing internally to the right handler per function, or this is a single shared variable that should be two (`main_lambda_filename` / `gitops_lambda_filename`) so each function ships only its own code.

Neither function sets `source_code_hash`, so Terraform won't detect a code change and trigger a redeploy unless the zip's filename itself changes between applies — see the runbook's redeploy notes.

The `depends_on` on each Lambda's CloudWatch log group is present in the source but **commented out** (`#depends_on = [aws_cloudwatch_log_group.main]` / `.gitops`) — as written today neither Lambda actually depends on its log group, so the known AWS/Terraform race (Lambda auto-creates a no-retention log group on first invoke, before Terraform's own log-group resource applies, causing a later `ResourceAlreadyExistsException`) is not currently guarded against.

## 7. IAM, secrets, and email

`main`'s policy scopes DynamoDB to the table and its two GSIs, SES sending to this account/region's identities, and `lambda:InvokeFunction` to the `gitops` function specifically. `gitops`'s policy scopes `secretsmanager:GetSecretValue` to its own secret, SES the same way, and DynamoDB read/write/scan to the table and the `submitted-by-created-at` index. Both are already scoped down rather than using `Resource = "*"` — the over-broad-`Resource` findings from an earlier review of this same code have already been addressed in this version.

The git-host token is stored in `aws_secretsmanager_secret_version.bitbucket`, whose `secret_string` comes directly from `var.bitbucket_secret_value` — as with any Terraform-managed secret value, this means the raw token is written into Terraform state (`terraform.tfstate`), which should be treated as sensitive (encrypted backend, restricted access) rather than a plain file, same caveat as any secret set this way.

`POST /bitbucket/webhook` has no signature verification configured in this Terraform (no HMAC shared-secret check implied anywhere in the route/integration setup) — the same known, shared gap called out for the org/personal stacks, not specific to this module.

## 8. Resilience: DLQ + retry sweep

Identical mechanism to the org/personal stacks: an EventBridge rule fires `gitops` with `{"action": "SWEEP"}` every 10 minutes, and an optional SQS DLQ (`enable_gitops_dlq`, on by default) catches anything that exhausts the Lambda's own built-in async retries. Whether `gitops`'s own code actually implements a `SWEEP` action, and what it does when invoked with one, isn't verifiable from this Terraform alone — confirm against that Lambda's actual source.

---

## Related documents

- [Operational Runbook](./dpc-self-service-portal-operational-runbook.md) — deployment (including the frontend build/push/invalidate steps), monitoring, and the pre-production checklist for the open items noted above.
- `portal-comprehensive-documentation.md` / `portal-operations-runbook.md` — the equivalent pair for the org/personal stacks, which this module's request/promotion design is based on.
