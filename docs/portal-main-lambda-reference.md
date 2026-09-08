# Main Lambda Reference

Part of the [Complete Portal Documentation](./portal-documentation-index.md). Covers `terraform/lambda/handler.py` (org stack, function name `<project>-<env>-request-api`) and its functionally-identical counterpart `terraform-personal/lambda-personal/handler.py`. Everything below applies to both unless noted.

## Role

The Main Lambda is the API surface the frontend talks to directly. It owns the DynamoDB `requests` table, decides whether a new request can start immediately or must queue, and hands off to the GitOps Lambda for anything that touches source control. It never calls the git host's API itself.

## Routes

All routes are handled by a single dispatcher, `handle_request(event)`, matched on HTTP method + path.

### `POST /dpc/request` — submit a new request

Validates `request_id`, `submitted_by.id`, `market_code`, and `environments` are present (400 if not). Computes `target_stages` via `compute_target_stages` — `['dev']` for a DEV-only request, `['dev','qa']` if QA was requested, `['dev','qa','master']` if PRD was requested (PRD is only reachable by passing through QA first; there's no way to request PRD alone). Then, **before the request item itself is written**, attempts to atomically claim `MARKETLOCK#<MARKET_CODE>` for this market:

- **Claimed** → status `REQUEST_RECEIVED`, the item is written, and `trigger_gitops` fires the GitOps Lambda asynchronously with `action: CREATE_PR`.
- **Not claimed** (another request for this market is already active) → status `QUEUED`, the item is written, nothing is triggered yet.

The lock claim happens before the item write specifically so there's never a window where the item exists but no decision between `REQUEST_RECEIVED`/`QUEUED` has been made yet. If the subsequent `put_item` fails on `attribute_not_exists(request_id)` (duplicate id) after a lock was claimed, that lock is released and forwarded to the next queued request rather than leaking until the staleness sweep finds it. Returns `201` with the assigned status, or `409` if the id already existed.

### `GET /dpc/listrequests` — list a user's requests

Requires `userId` query param (400 without it). Queries the `submitted-by-created-at` GSI for that user, newest first, paginating through `LastEvaluatedKey` until exhausted so a user with many requests still gets the complete list in one response.

### `GET /dpc/requests/{request_id}` — request detail

Requires `userId` (400 without it); returns `404` if the item doesn't exist or belongs to a different `submitted_by_id` — a user can only ever look up their own requests through this route. Builds the response from `frontend_request(item)` plus `stage_summary(item)` (target/current stage, per-stage PR links). If the status is `QUEUED`, also looks up the market's lock item and returns `blockedBy`: the id of the request currently holding it, so the UI can show what it's waiting behind.

### `GET /dpc/whitelist/{market_code}/{environment}` — live whitelist read

Synchronously (`InvocationType="RequestResponse"`) invokes the GitOps Lambda with `action: GET_WHITELIST`. This is the only synchronous cross-Lambda call in the whole system — everything else is fire-and-forget. Returns `503` if the GitOps Lambda name isn't configured, `502` if the invoke itself fails or the GitOps Lambda reports an error.

### `POST /dpc/requests/{request_id}/release-lock` — admin: force-release a market lock

Looks up the request, reads its `market_code`, and calls `_admin_force_release_market_lock`. Not gated by any backend authorization check today — see [Known Issues & Roadmap](./portal-known-issues-roadmap.md); the frontend only shows the button to ADMIN-role users.

### `POST /dpc/requests/{request_id}/retry-promotion` — admin: force-retry a stuck promotion

Calls `_admin_force_retry_promotion(request_id, now)`. Returns `400` if the request doesn't exist or has no further stage to promote into. On success, releases and discards the (orphaned) lock for that market/branch — including its `PR#<id>` lookup item, so a delayed webhook for the stale PR can't resurrect it — and re-claims a fresh one via `trigger_promotion`, opening a new promotion PR. Same authorization caveat as release-lock above.

### `POST /dpc/bitbucket/webhook` — inbound git-host webhook

Parses the JSON body and hands off to `handle_webhook`. See "Webhook handling" below.

Every route returns its response through a shared `response()` helper that sets CORS headers based on the request's `Origin` header matched against `allowed_origins` (from `CORS_ALLOW_ORIGINS`). Any unhandled exception in `handle_request` is caught by the outer `lambda_handler` and turned into a generic `500`, so a bug in one route can't leak a raw stack trace to the client.

## Webhook handling

`handle_webhook` branches on the PR's source branch name:

- **`gitops/REQ-xxxxxxxx`** (a per-request branch, identified purely by name) → the original request PR into `dev`. Resolved directly to that one `request_id`.
- **Anything else with a PR id** → could be a dev→qa or qa→master promotion PR (persistent branch names, no slash) or something unrelated to the portal. Resolved by looking up `PR#<pr_id>` in DynamoDB; a miss means "not ours" and the webhook is acknowledged and ignored (`200`) rather than erroring.

Either way, resolution lands in `handle_stage_event(event_key, request_ids, ...)`, which maps the Bitbucket event key to a status via `WEBHOOK_STATUS_MAP` (`pr:opened`→`PR_CREATED`, `pr:modified`→`PR_UPDATED`, `pr:reviewer:approved`→`PR_APPROVED`, `pr:reviewer:needs_work`→`PR_NEEDS_WORK`, `pr:merged`→`COMPLETED`, `pr:declined`→`PR_DECLINED`, `pr:deleted`→`PR_DELETED`) and applies it to every request id riding that PR via `_update_item`.

`_update_item` uses a conditional update (`stage_index < :si`, guarded by an `attribute_not_exists OR #s <> :s` condition) so a duplicate or out-of-order webhook delivery — a Bitbucket redelivery, or the same shared promotion PR firing once per market riding it — can never stomp a request's status back to something earlier than where it already is.

On `pr:merged`, `advance_stage(item)` decides whether there's a next stage: if so, `trigger_promotion` is called for that market/branch (joining an existing promotion lock if one's already open for the same market+branch, or claiming a fresh one and opening a new promotion PR); if not, the request is `COMPLETED` and `notify_requester_merged` sends the (optional, SES-gated) completion email.

## Locking primitives (this Lambda's half)

- **`_claim_market_lock(market_code, request_id, now, allow_stale_reclaim=True)`** — atomic conditional `put_item` on `MARKETLOCK#<MARKET_CODE>`. If the existing lock is older than `MARKET_LOCK_STALE_SECONDS` (default 24h, env var `MARKET_LOCK_STALE_SECONDS`), it's treated as abandoned and reclaimed.
- **`_release_and_forward_market_lock`** — called when a request reaches a terminal state (or fails to persist after claiming). Finds the oldest `QUEUED` request for that market (via the `market-code-created-at` GSI) and promotes it to `REQUEST_RECEIVED`, triggering its GitOps run — this is what makes the queue actually advance.
- **`_join_promotion_lock` / `trigger_promotion` / `_release_promotion`** — the equivalent claim/ride-along/release cycle for `LOCK#<market>#<branch>` promotion locks, used when a request needs to move from one stage's branch to the next.
- **`_admin_force_release_market_lock`** / **`_admin_force_retry_promotion`** — the two admin recovery paths described above, both explicitly the "someone got stuck, unstick it" escape hatches rather than part of the normal flow.

## Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `DYNAMODB_TABLE` | Table name |
| `CORS_ALLOW_ORIGINS` | JSON array of allowed browser origins |
| `GITOPS_LAMBDA_NAME` | Function name to invoke for GET_WHITELIST/CREATE_PR |
| `DOMAIN` | Builds `noreply@<domain>`; empty disables the requester-notification email |
| `BITBUCKET_URL` / `PROJECT_KEY` / `REPO_NAME` (org) or GitHub equivalents (personal) | Used only to build a human-viewable PR link per stage — this Lambda never calls the git host's API |
| `MARKET_LOCK_STALE_SECONDS` | Staleness threshold for reclaiming an abandoned market lock (default 86400) |

## IAM

DynamoDB `PutItem`/`GetItem`/`Query`/`UpdateItem`/`DeleteItem` on the table and both GSIs (`UpdateItem` specifically because the webhook handler advances status in place); `lambda:InvokeFunction` scoped to the GitOps Lambda only; `ses:SendEmail`/`ses:SendRawEmail` scoped to `identity/*`; standard CloudWatch Logs create/put permissions.
