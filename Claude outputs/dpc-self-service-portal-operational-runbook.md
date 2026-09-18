# `dpc-self-service-portal` Module — Operational Runbook

This is the "how do I deploy and run this module day-to-day, and what should I check before it goes to production" reference for the `dpc-self-service-portal` module — a separate system from the org/personal stacks documented elsewhere in this project. For how the module is *built*, see the [Comprehensive Documentation](./dpc-self-service-portal-comprehensive-documentation.md) instead of duplicating that detail here.

Built entirely from the Terraform source provided for review — no live deployment of this module was available to verify against, so several items below are framed as "confirm this" rather than "here's the answer," and are called out as such.

## Deploying the backend

Standard Terraform flow — nothing in this module's snippet indicates a wrapper script (unlike the org/personal stacks' `setup.sh`):

```bash
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

This provisions (in one pass): the DynamoDB table, both Lambdas, their IAM roles/policies, the API Gateway HTTP API and its `dpc` stage, the Secrets Manager secret (name and value supplied via `var.bitbucket_secret_name`/`var.bitbucket_secret_value`), the optional SQS DLQ, the EventBridge sweep rule, and the S3 bucket + CloudFront distribution for the frontend. A first-time apply also has to wait for CloudFront distribution creation/propagation, which is typically the slowest single step in the plan (can take several minutes).

## Deploying a frontend update

The frontend is built locally and pushed to the S3 bucket Terraform provisions — this is **not** part of `terraform apply` and needs to happen as its own step, every time the frontend changes:

```bash
npm run build
aws s3 sync dist/ s3://<frontend-bucket-name>/ --delete
aws cloudfront create-invalidation --distribution-id <distribution-id> --paths "/*"
```

**The invalidation step matters and is easy to forget.** The distribution sets no explicit cache TTLs, so it falls back to CloudFront's own default/max TTL (24 hours under the cache-behavior style used here). Skipping the invalidation after a sync means viewers can keep getting a stale `index.html`/JS bundle for up to that long. If this deploy is wrapped in a CI job, confirm the invalidation call is actually part of it — a sync-only script will "work" (the files are in S3) while still not reaching users promptly.

Get the bucket name and distribution id from `terraform output` (or the AWS Console) after the backend `apply` has provisioned them once.

## Monitoring

Unlike the org/personal stacks (CloudWatch Logs only, no APM), both Lambdas here are instrumented with a New Relic layer and extension — expect request traces, error rates, and cold-start/duration metrics to be visible in New Relic (under whatever `NEW_RELIC_ACCOUNT_ID` is configured), not just CloudWatch. That's a meaningfully better starting point for monitoring than the other two stacks have today, provided the New Relic license key/account are actually valid and the dashboards/alerting on the New Relic side have been set up — this Terraform only wires the *instrumentation*, it doesn't create any New Relic-side alert policies.

Beyond New Relic:

- **CloudWatch Log Groups**: `/aws/lambda/${aws_lambda_function.main.function_name}` and `.../gitops`, 30-day retention on both.
- **The DLQ** (if `enable_gitops_dlq = true`): an SQS queue named `${var.project_name}-gitops-dlq`. A message here means a GitOps action exhausted every retry layer.
- **The sweep rule**: `${var.project_name}-gitops-sweep`, firing every 10 minutes. No separate log for the rule itself — check the `gitops` Lambda's own logs (and New Relic traces) for its executions.
- **CloudFront**: standard CloudFront metrics (requests, error rate, cache hit ratio) are available in CloudWatch under the distribution — useful for confirming the invalidation step above is actually happening (a cache hit ratio that never drops after a deploy is a sign invalidation isn't running).
- **DynamoDB**: `PAY_PER_REQUEST` billing — check `ThrottledRequests` if things seem slow under load.

As with the org/personal stacks, there's no evidence in this Terraform of CloudWatch Alarms or SNS topics wired up — if proactive paging/alerting is expected, confirm whether that's handled entirely on the New Relic side (alert policies configured there, outside this Terraform) or is genuinely not set up anywhere yet.

## Redeploying after a code change

`terraform apply` rebuilds and redeploys whenever the referenced Lambda zip changes — but two things about this module make that less automatic than in the org/personal stacks:

- **No `source_code_hash`** on either Lambda function resource. Terraform normally detects "the code changed" by hashing the deployment package; without that, a code change alone won't trigger a redeploy unless the zip's *filename* also changes between applies (e.g. a version-stamped filename) or the file's `filename`/`s3_key` reference itself changes. Confirm how the build pipeline names the zip it produces — if it's a fixed name that gets overwritten in place, `terraform apply` may see "no change" and skip redeploying even though the code is different.
- **Both `main` and `gitops` reference the same `var.lambda_filename`.** If they're genuinely one shared package, redeploying either one redeploys both (fine, if that's the intent). If they're meant to be separate codebases, confirm the build/CI process produces (and Terraform is pointed at) two distinct zips — see the note in the [Comprehensive Documentation](./dpc-self-service-portal-comprehensive-documentation.md#6-lambdas).

## Pre-production checklist

None of these are necessarily broken — they're points this Terraform alone can't confirm, worth explicitly checking off against the real deployment plan before this module is relied on in production:

1. **Resource names carry no `${var.environment}` suffix** — the DynamoDB table, both Lambda function names, both IAM roles/policies, and the API are all named from `${var.project_name}` alone (only the S3 bucket includes `${var.environment}`). If `dev`/`qa`/`prod` (or similar) are ever deployed into the *same* AWS account/region, these would collide. Confirm each environment gets its own account/region, or add the missing suffix before a second environment is deployed.
2. **`main`/`gitops` sharing one `lambda_filename`** — confirm this is intentional.
3. **No `source_code_hash`** — confirm the build/CI pipeline's zip-naming actually forces Terraform to see code changes; otherwise a `terraform apply` after a code-only change can silently no-op.
4. **Log-group `depends_on` lines are commented out** — decide whether to re-enable them to close the known Lambda/CloudWatch log-group creation race.
5. **No explicit CloudFront TTLs** — confirm the deploy process invalidates the distribution on every frontend push (see above); otherwise the default 24h TTL governs staleness.
6. **No webhook signature verification** on `POST /bitbucket/webhook` — same known, shared gap as the org/personal stacks. Anyone who can guess/obtain a `request_id` could in principle forge a merge event, same risk profile as documented for those two stacks.
7. **Secrets Manager value in Terraform state** — the git-host token is written into `terraform.tfstate` via `secret_string = var.bitbucket_secret_value`. Confirm the state backend is encrypted and access-restricted.
8. **New Relic alerting** — this Terraform wires instrumentation only; confirm alert policies/dashboards exist on the New Relic side if proactive notification is expected.

---

## Related documents

- [Comprehensive Documentation](./dpc-self-service-portal-comprehensive-documentation.md) — architecture, frontend hosting design, API routes, DynamoDB schema, Lambda configuration, IAM.
- `portal-operations-runbook.md` — the equivalent runbook for the org/personal stacks, which share this module's core request/promotion design.
