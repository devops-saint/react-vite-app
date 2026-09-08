# GitOps Lambda Reference

Part of the [Complete Portal Documentation](./portal-documentation-index.md). Covers `terraform/lambda-gitops/handler.py` (org stack, function name `<project>-<env>-gitops`) and its functionally-identical counterpart `terraform-personal/lambda-gitops-personal/handler.py` (GitHub instead of Bitbucket Server). Everything below applies to both unless noted.

## Role

This is the only part of the system that talks to source control. It reads/writes the per-market YAML config files, creates branches and pull requests, and drives the automatic dev→qa→master promotion pipeline once a request is merged. It's invoked by the Main Lambda (synchronously for reads, asynchronously for writes) and on a fixed schedule by EventBridge for the retry sweep. It never receives a request directly from the frontend.

## Entry point and actions

`lambda_handler` first fetches the git host token from Secrets Manager (`sm.get_secret_value`, `SecretId` must match `var.bitbucket_token_secret_name` / `var.github_token_secret_name`) — raises immediately if the secret is empty. Then dispatches on `event["action"]` (default `CREATE_PR` if omitted):

| Action | Handler | Trigger |
|---|---|---|
| `CREATE_PR` | `handle_create_pr` | Main Lambda, async, on request submission |
| `GET_WHITELIST` | `handle_get_whitelist` | Main Lambda, **sync**, on `GET /dpc/whitelist/{market}/{env}` |
| `PROMOTE` | `handle_promote` | This Lambda itself, when a request PR merges and there's a next stage |
| `SWEEP` | `handle_sweep` | EventBridge, on schedule (default every 10 minutes) |

`CREATE_PR` and `PROMOTE` run inside a shared try/except: if either raises after exhausting in-function retries, `_report_failure` records the failure to DynamoDB (marking the request `SYNC_FAILED` or the lock `FAILED`, depending on which action) so the UI reflects it and the sweep can retry it later — then the exception is **re-raised**, so Lambda's own built-in async retries (2 more, over several minutes) and the on-failure destination (the DLQ, if enabled) still apply as a second layer of defense on top of the sweep.

## Retry/resilience for git-host calls

Every Bitbucket/GitHub API call goes through `_request_with_retry`: up to `MAX_HTTP_ATTEMPTS` (3) attempts, with backoff `RETRY_BACKOFF_SECONDS = [2, 5]` between attempts. Retries on network-level exceptions and on `RETRYABLE_STATUS_CODES` (`429, 500, 502, 503, 504`) — deliberately **not** on other 4xx responses, since those won't succeed on retry and would just burn the retry budget. This is sized to absorb a brief outage or maintenance window without the whole sync failing; the Lambda's 240s timeout is set to give this budget room to actually play out on one call.

## `CREATE_PR` — `handle_create_pr`

1. Branch name is always `gitops/<request_id>`.
2. Gets the latest commit on `dev` (`SOURCE_BRANCH`), creates the new branch from it. Branch creation is idempotent: a `409` with "already exists" is treated as success and logged, not an error — this covers a retry (built-in Lambda retry, or a sweep re-attempt) landing after an earlier attempt got partway through.
3. `process_yaml_updates` reads the current `values.<env>.yaml` for each requested environment off the new branch, adds the requested resources under the right section (`buckets`, `secrets`, `kmsKeys`, `functions` — `SUPPORTED_SECTIONS`), and returns the updated file contents. If nothing actually changed (e.g. everything requested was already present), returns early with `"No files require updating"` rather than opening an empty PR.
4. Commits the updated file(s) to the branch (`commit_files`), opens a pull request from the branch into `dev` (`create_pull_request`), and notifies approvers (`notify_approvers_pr_created`, SES — see below).

YAML is parsed/written with `ruamel.yaml` specifically to preserve comments, quoting, and key ordering in the config files rather than round-tripping through a lossy generic YAML/dict conversion — a config file managed partly by hand and partly by this pipeline needs to stay diff-friendly either way.

## `GET_WHITELIST` — `handle_get_whitelist`

Reads and parses the **live** `values.<env>.yaml` straight off the persistent branch for that environment (`ENV_TO_BRANCH`: `dev`→`dev`, `qa`→`qa`, `prd`→`master`) — not anything DynamoDB has recorded, since DynamoDB only tracks request history, not current desired state. This is why "current whitelist" in the UI can differ from "what any single request asked for": it's always the actual merged file. This is the one action invoked synchronously (`RequestResponse`), so it has no independent timeout of its own beyond the 30s API Gateway integration ceiling described in the [Architecture doc](./portal-architecture-infrastructure.md).

## `PROMOTE` — `handle_promote`

Opens a plain branch-to-branch pull request (no new commits, no cherry-picking) between two persistent branches — `dev`→`qa` or `qa`→`master` — which is safe because each environment keeps its own YAML file, so a promotion PR's diff is exactly "what changed in that environment's file since it was last promoted."

The tricky part is that `dev`, `qa`, and `master` are **shared trunk branches across every market**, and a git host allows only one open PR for a given (from, to) branch pair at a time. If two different markets' requests both need to promote `dev`→`qa` within a short window of each other, `create_pull_request`'s duplicate-PR handling can hand the second caller back the **same PR** the first one just opened. `_link_promotion_pr` handles this correctly: it records this promotion's `request_ids`/`lock_key` against the shared `PR#<pr_id>` item, merging into whatever is already recorded there (via a conditional create that falls back to a read-modify-write merge) rather than overwriting it. This exact bug was found and fixed during development — a naive `put_item` here meant the market whose `handle_promote` ran last silently kept the `PR#<id>` mapping while every earlier market's request(s) riding the same promotion PR were permanently orphaned, sitting at `LOCK#<market>#<branch>` forever with no way to advance when the shared PR eventually merged. The merge is not transactional (a very tight race between two merges could in theory still drop one), but every value merged this way is idempotent to accumulate twice, so the worst case is far short of the silent data loss it replaces.

`_append_history` best-effort-records that a promotion PR was opened onto each linked request's `history` — deliberately without touching `status` (only the Main Lambda's `handle_stage_event`, driven by the real webhook, changes status), and deliberately tolerant of a missing item or DynamoDB error, since a promotion PR that already exists upstream must not be treated as failed just because this bookkeeping step failed.

## `SWEEP` — `handle_sweep`

Invoked on the schedule described in the [Architecture doc](./portal-architecture-infrastructure.md). Two independent scans, both using `Attr(...)`-based filter expressions on a table `Scan` (the one place this Lambda scans rather than queries, since "everything stuck" isn't naturally keyed):

1. **Requests at `SYNC_FAILED`** — for each, if it's older than `SWEEP_STALE_MINUTES` (10) and hasn't hit `SYNC_MAX_AUTO_RETRIES` (5) yet, retries by calling `handle_create_pr` again directly with the item's stored `payload`. An item with no stored payload can't be retried and is skipped with a log line rather than raising.
2. **Orphaned promotion locks** — `LOCK#`-prefixed items with `status=FAILED`, or `status=CLAIMING` with no `pr_id` ever recorded (meaning the Lambda crashed before it could even self-report the failure). Same staleness/retry-cap logic, retried via `handle_promote`.

Both loops check `context.get_remaining_time_in_millis()` before each item and stop early (`SWEEP_TIME_BUDGET_MARGIN_MS` = 30000, i.e. 30s of headroom) if time is running low, so a long-lasting outage with many stuck items can't blow the Lambda's own timeout mid-sweep — whatever's left over is simply picked up on the next scheduled run. Items that exceed the retry cap are reported back (`requests_skipped_cap` / `locks_skipped_cap`) in the sweep's return value (visible in CloudWatch Logs) rather than retried forever.

## Approver notifications (SES)

`notify_approvers_pr_created` and `notify_approvers_promotion_created` send to `PR_APPROVER_EMAILS` (parsed from the comma-separated `PR_APPROVER_EMAILS` env var) from `NOTIFICATION_FROM_EMAIL` (`noreply@<DOMAIN>`, or `None` if `DOMAIN` is unset). Both are skipped with a log line — never a failure — if either the recipient list or the sender address isn't configured, so notification is additive and never blocks the actual git operations it's reporting on.

## Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `DYNAMODB_TABLE` | Table name (looked up lazily so a missing value can't break `CREATE_PR`, which doesn't need it) |
| `BITBUCKET_URL` / `PROJECT_KEY` / `REPO_NAME` (org) or GitHub equivalents (personal) | **Required** — every invocation fails without them |
| `REPO_BASE_PATH` | **Required** — path inside the repo under which each market's `values.<env>.yaml` files live |
| `PR_APPROVER_USERNAMES` | Added as reviewers on every opened PR (optional — empty skips reviewer assignment) |
| `PR_APPROVER_EMAILS` | SES notification recipients (optional) |
| `DOMAIN` | Builds the SES sender address; empty disables notification emails entirely |

## IAM

`secretsmanager:GetSecretValue` on the git host token secret; DynamoDB `GetItem`/`PutItem`/`UpdateItem`/**`Scan`** on the table (`Scan` exists solely for `handle_sweep`); `ses:SendEmail`/`ses:SendRawEmail` scoped to `identity/*`; CloudWatch Logs; and, when `var.enable_gitops_dlq` is true, `sqs:SendMessage` to its own dead-letter queue (used by Lambda's own async on-failure destination mechanism, under this function's execution role).
