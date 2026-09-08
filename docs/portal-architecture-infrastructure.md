# Architecture & Infrastructure

Part of the [Complete Portal Documentation](./portal-documentation-index.md).

## Two parallel stacks

The portal is deployed as two independent Terraform stacks that share the same design and the same frontend codebase, but talk to different source-control hosts:

| | `terraform/` (org stack) | `terraform-personal/` (personal stack) |
|---|---|---|
| Source control | Bitbucket Server | GitHub |
| Main Lambda source | `terraform/lambda/handler.py` | `terraform-personal/lambda-personal/handler.py` |
| GitOps Lambda source | `terraform/lambda-gitops/handler.py` | `terraform-personal/lambda-gitops-personal/handler.py` |
| Credential variable | `bitbucket_token_secret_name` | `github_token_secret_name` |
| Repo location variables | `bitbucket_url` + `project_key` + `repo_name` | `github_owner` + `github_repo` |
| Webhook route | `POST /dpc/bitbucket/webhook` | GitHub-equivalent webhook route |

Every backend fix made during this engineering effort was applied to both stacks and diff-verified to be functionally identical between them — the two are kept in lockstep by convention, not by any shared Terraform module.

## System diagram

```mermaid
flowchart TB
    User[User's browser] -->|Azure AD SSO login| SPA[React SPA]
    SPA -->|HTTPS| APIGW[API Gateway HTTP API]
    APIGW -->|AWS_PROXY| MainLambda["Main Lambda\n(request_api / *-request-api)"]
    MainLambda -->|read/write| DDB[(DynamoDB\nrequests table)]
    MainLambda -->|Invoke: GET_WHITELIST\n(sync, RequestResponse)| GitopsLambda["GitOps Lambda\n(gitops)"]
    MainLambda -->|Invoke: CREATE_PR\n(async, Event)| GitopsLambda
    GitopsLambda -->|read/write| DDB
    GitopsLambda -->|REST API calls| GitHost[Bitbucket Server / GitHub]
    GitopsLambda -->|SendEmail| SES[Amazon SES]
    GitHost -->|webhook: PR opened/approved/merged/declined| APIGW
    EventBridge["EventBridge rule\n(rate(10 min))"] -->|action: SWEEP| GitopsLambda
    GitopsLambda -.on exhausted retries.-> DLQ[(SQS DLQ\noptional)]
```

## Data store: DynamoDB `requests` table

Single table, `PAY_PER_REQUEST` billing, point-in-time recovery and encryption both on. Hash key: `request_id`. The same table holds several distinct kinds of item, distinguished by a prefix convention on `request_id`:

- **`<request_id>`** (a plain UUID/opaque id) — the whitelist request itself: `status`, `market_code`, `createdAt`, `updatedAt`, `submitted_by_id`, the original `payload`, `target_stages`, `stage_index`, and a `history` array of status transitions.
- **`MARKETLOCK#<MARKET_CODE>`** — a per-market lock claimed atomically when a request is submitted, so only one request per market is ever in flight at a time; everything else for that market queues behind it. Auto-released after `market_lock_stale_seconds` (default 24h) if abandoned, or force-released by an admin via `POST /dpc/requests/{id}/release-lock`.
- **`LOCK#<market>#<branch>`** — claimed by the GitOps Lambda while a dev→qa or qa→master promotion PR is in flight for a given market/branch, so multiple requests promoting at once can "ride along" on the same promotion PR instead of each opening a duplicate one.
- **`PR#<pull_request_id>`** — a lookup item mapping a Bitbucket/GitHub PR id back to the request id(s) it represents, so an inbound webhook (which only carries a PR id) can resolve which request(s) to update.

Two Global Secondary Indexes, both `ALL` projection:

- **`submitted-by-created-at`** (hash `submitted_by_id`, range `createdAt`) — powers "list my requests," queried instead of scanned.
- **`market-code-created-at`** (hash `market_code`, range `createdAt`) — powers finding the oldest `QUEUED` request for a market when its lock is released, also a query instead of a scan.

All concurrency control is built on DynamoDB's atomic conditional writes (`ConditionExpression="attribute_not_exists(...)"` on lock/lookup items) rather than any external locking service — this is the sole concurrency primitive the whole pipeline relies on.

## API Gateway (HTTP API) routes

One HTTP API per stack, `AWS_PROXY` integration into the Main Lambda, `$default` stage with `auto_deploy = true` (Terraform applies go live immediately, no separate deploy step). CORS origins/headers/methods are Terraform variables.

| Route | Purpose | Auth today |
|---|---|---|
| `POST /dpc/request` | Submit a new whitelist request | None |
| `GET /dpc/listrequests` | List a user's own requests (`userId` query param) | None |
| `GET /dpc/requests/{request_id}` | Request detail | None |
| `GET /dpc/whitelist/{market_code}/{environment}` | Read the live current whitelist (synchronously invokes the GitOps Lambda) | None |
| `POST /dpc/requests/{request_id}/release-lock` | Admin: force-release a market lock | None (gated only in the frontend UI) |
| `POST /dpc/requests/{request_id}/retry-promotion` | Admin: force-retry a stuck promotion | None (gated only in the frontend UI) |
| `POST /dpc/bitbucket/webhook` | Inbound webhook from the git host, drives status transitions | None (no signature verification) |

The integration timeout is a fixed 30 seconds (an API Gateway HTTP API limit that cannot be raised), which is why the Main Lambda's own timeout is set to 29s — its one synchronous downstream call (`GET_WHITELIST`, invoked `RequestResponse` into the GitOps Lambda) has to complete inside that window or the caller gets cut off regardless of either Lambda's own configured timeout.

See [Known Issues & Roadmap](./portal-known-issues-roadmap.md) for the authentication and webhook-signature gaps implied by the "None" column above, and the existing SSO implementation plan doc for how to close the authentication one.

## Main Lambda (`request_api` / `*-request-api`)

Runtime `python3.12`, 256MB, 29s timeout. Full route-by-route behavior is in the [Main Lambda Reference](./portal-main-lambda-reference.md). IAM: DynamoDB read/write on the table and both GSIs, `lambda:InvokeFunction` on the GitOps Lambda only, `ses:SendEmail`/`ses:SendRawEmail`, and standard CloudWatch Logs permissions.

## GitOps Lambda (`gitops` / `*-gitops`)

Runtime `python3.12`, 256MB, **240s** timeout — sized for the worst case of `_request_with_retry`'s in-function retry budget (multiple attempts at up to a 60s per-call timeout, plus backoff) on a single call to the git host. Ships a Lambda layer bundling `requests` and `ruamel.yaml` (not in the base Python runtime), built by a `local-exec` provisioner that installs them from `requirements.txt` at `terraform apply` time — this requires `pip3`/`pip`/`python -m pip` to be available on whatever machine runs the apply, with OS-conditional (Windows/Unix) shell handling in the provisioner. Full action-by-action behavior is in the [GitOps Lambda Reference](./portal-gitops-lambda-reference.md). IAM: `secretsmanager:GetSecretValue` on the git host token secret, DynamoDB read/write/**scan** on the table (scan is used only by the scheduled sweep to find stuck items), SES send, CloudWatch Logs, and (conditionally) `sqs:SendMessage` to its own dead-letter queue.

## Retry sweep (EventBridge)

`aws_cloudwatch_event_rule "gitops_sweep"` fires the GitOps Lambda with `{"action": "SWEEP"}` on a schedule (`var.sweep_schedule_expression`, default `rate(10 minutes)`). `handle_sweep` scans for two categories of stuck item — requests at `SYNC_FAILED` and orphaned promotion locks (`FAILED`, or `CLAIMING` with no `pr_id` ever recorded) — and retries anything older than `SWEEP_STALE_MINUTES` (10, a Python constant kept in sync with the Terraform schedule by convention, not code) that hasn't already exhausted `SYNC_MAX_AUTO_RETRIES` (5) attempts. It stops early if the Lambda's own remaining execution time drops below a 30-second safety margin, leaving anything unprocessed for the next scheduled run rather than risking a mid-item timeout.

## Dead-letter queue (optional)

`aws_sqs_queue "gitops_dlq"`, 14-day retention, is the on-failure destination for the GitOps Lambda's asynchronous invocations. It exists purely as a last-resort visibility/inspection backstop for an event that has exhausted both the in-function retries and Lambda's own built-in async retries — the scheduled sweep above does not depend on it at all and keeps working without it. Creation is gated behind `var.enable_gitops_dlq` (default `true`) because some AWS organizations block `sqs:CreateQueue` via a Service Control Policy; setting it `false` still leaves the rest of the stack, including the sweep's automatic recovery, fully deployable.

## Email notifications (SES)

Both Lambdas hold SES send permissions scoped to `identity/*` in the account/region. The GitOps Lambda sends approver notifications (to `pr_approver_emails`) when a request PR or a promotion PR opens; the Main Lambda sends a requester notification (see the Main Lambda Reference for exactly when). Both are gated on a verified SES identity: if `var.domain` is left empty, `NOTIFICATION_FROM_EMAIL` resolves to `None` and the relevant send is skipped with a log line rather than failing the request — email is a nice-to-have layered on top of a pipeline that otherwise works entirely without it.

## Promotion pipeline: dev → qa → master

A request's `target_stages` (computed at submission from which environments were requested) determines how far it needs to promote. The GitOps Lambda opens the initial PR into the `dev` branch; once merged, the webhook-driven flow (see [GitOps Lambda Reference](./portal-gitops-lambda-reference.md)) automatically opens a promotion PR from `dev` into `qa`, and from `qa` into `master` (which represents PRD), reusing one promotion PR to carry multiple requests' changes if they're already riding the same lock when it opens.
