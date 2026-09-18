# Operations Runbook

Part of the [Complete Portal Documentation](./portal-documentation-index.md). This doc is the "how do I run this thing day-to-day, and what do I do when it breaks" reference — for how the system is *built*, see the [Comprehensive Documentation](./portal-comprehensive-documentation.md) instead of duplicating that detail here.

Covers both stacks: the org stack (`terraform/`, Bitbucket-backed) and the personal test stack (`terraform-personal/`, GitHub-backed). They're deployed independently — nothing here assumes both are up.

## Deployment

### Automated path (`setup.sh`)

Both stacks ship a `setup.sh` that does the whole thing in one shot: stores the token in Secrets Manager, writes `terraform.tfvars`, runs `terraform init && terraform apply`, registers the webhook, and updates the frontend `.env`.

**Org stack:**
```bash
cd terraform
BITBUCKET_URL=https://bitbucket.example.com \
PROJECT_KEY=<your-project-key> \
REPO_NAME=<your-repo-slug> \
BITBUCKET_TOKEN=<access-token-with-repo-admin-and-read/write> \
./setup.sh
```
Add `-y` (or `AUTO_APPROVE=1`) for an unattended run. Optional: `REPO_BASE_PATH`, `AWS_REGION`, `BITBUCKET_TOKEN_SECRET_NAME`, `PR_APPROVER_EMAILS`, `DOMAIN` (see `terraform/SETUP.md` for the full list).

**Personal/test stack:**
```bash
cd terraform-personal
GITHUB_OWNER=<github-username-or-org> \
GITHUB_REPO=<empty-repo-you-created> \
GITHUB_TOKEN=<PAT-with-Contents+PullRequests+Webhooks-read/write> \
./setup.sh
```
Same `-y`/`AUTO_APPROVE=1` option. Optional: `REPO_BASE_PATH`, `MARKETS`, `AWS_REGION`, `GITHUB_TOKEN_SECRET_NAME`, `PR_APPROVER_EMAILS`, `DOMAIN` (see `terraform-personal/SETUP.md`).

The script prints a summary on completion (API URL, webhook URL, DLQ URL, sweep rule name) and updates the frontend `.env`/`.env.personal` for you (just `VITE_API_BASE_URL`/`VITE_REPOSITORY_NAME` — nothing else in that file is touched).

### Manual path

If a step in the automated run fails partway, `terraform/SETUP.md` and `terraform-personal/SETUP.md` both have an "Option B: manual" section walking through exactly what the script automates, so you can resume from wherever it stopped rather than re-running the whole thing.

Bare Terraform, if you're doing this by hand:
```bash
cd terraform   # or terraform-personal
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

### Frontend

The frontend (the React SPA) is **not managed by either Terraform stack** — it's built with `npm run build` and hosted/deployed separately, wherever your org serves static sites from. Before deploying it anywhere outside local dev, make sure `cors_allow_origins` on the backend stack includes that exact origin (see the CORS troubleshooting entry below).

### The one deployment gotcha worth knowing before you touch `terraform.tfvars` by hand

The Secrets Manager secret name used by each GitOps Lambda is **hardcoded as a literal string in the Python code** (`SecretId="bitbucket-token"` / `SecretId="github-token"`), not read from an environment variable. If you rename `bitbucket_token_secret_name` / `github_token_secret_name` away from its default in `terraform.tfvars`, Terraform will happily create a differently-named secret, but the Lambda will still look for one literally named `bitbucket-token`/`github-token` and fail every invocation. If you need a different secret name, you have to update the `SecretId=` literal in `handler.py` to match — the variable's own description calls this out, but it's easy to miss.

## Required configuration — the system does nothing until these are set

Four Terraform variables per stack are marked `REQUIRED` and have no usable default — leaving any of them unset means the GitOps Lambda fails on **every single invocation**, not just some edge case:

| Org stack | Personal stack | What it is |
|---|---|---|
| `bitbucket_url` | — | Base URL of the Bitbucket Server instance |
| `project_key` | `github_owner` | Which project/account owns the config repo |
| `repo_name` | `github_repo` | The config repo itself |
| `repo_base_path` | `repo_base_path` | Path inside the repo under which each market's `values.<env>.yaml` files live |

`setup.sh` forces you to supply the git-host-specific ones as required environment variables up front, so this is mostly a concern for the manual path or for reviewing an existing `terraform.tfvars`.

## PR Review Process for Developers

The pipeline opens pull requests; it does not review or merge them — that step is always a human, on the git host itself.

1. When the GitOps Lambda opens a request PR (into `dev`) or a promotion PR (`dev`→`qa` or `qa`→`master`), it sends a plain SES email to every address in `PR_APPROVER_EMAILS`, linking to the PR. **No reviewers are auto-assigned on the PR itself** — this was a deliberate change; approvers are notified by email only, and have to open the PR directly (via the emailed link, the git host's own PR list, or — if they're an ADMIN-role portal user — the PR link surfaced on the Request Details page).
2. The diff to review is always a change to one market's `values.<env>.yaml` file — typically a small, additive change (new entries under `buckets`/`secrets`/`kmsKeys`/`functions`). Reviewing it is a normal git-host PR review: read the diff, check it matches the business justification on the request, approve or request changes using the git host's native review UI.
3. **Approve + merge** on the git host is what drives the portal forward — there is no separate "approve" action inside the portal itself. Once merged, the git host's webhook fires, the portal picks up the merge, and (if there's a next stage) automatically opens the next promotion PR for the *next* reviewer to repeat this process on.
4. **Request changes / decline** on the git host maps back to `PR Needs Work` / `PR Declined` in the portal automatically via the same webhook — no separate step needed to reflect that back to the requester.
5. Branch protection / required-approvers enforcement (who is *allowed* to approve, how many approvals are required) is configured on the git host itself (Bitbucket/GitHub branch permissions), not by the portal — the portal's `PR_APPROVER_EMAILS` list controls only who gets *notified*, not who is *authorized* to approve.

## How Requests Become Completed

There is **no manual "mark as completed" action anywhere** — not in the portal UI, not as an API route. Completion is entirely a side effect of the normal PR-merge flow:

- On every `pr:merged` webhook event, `advance_stage()` checks whether the request has a next stage in its `target_stages`.
- If yes, a promotion PR opens for the next stage (see [PR Review Process](#pr-review-process-for-developers) above) — status stays in-flight.
- If no (the request's *last* target stage just merged), the request is set to `COMPLETED` directly, and — if a sending domain is configured — the requester gets a completion email.

In other words: to "complete" a request, merge its final pull request on the git host. There's nothing else to click. If a request looks functionally finished but is stuck showing an earlier status, that's a stuck-promotion or sync-failure situation (see the incident playbook below), not a missing "mark complete" step — use **Retry Promotion** from the Request Details page (admin-only) rather than trying to force the status directly in DynamoDB, since a manual status edit bypasses the item's `history[]` and PR-link bookkeeping and won't trigger the completion email.

## Monitoring — what exists today, and what doesn't

Be upfront about this with anyone asking: **there is no automated alerting configured on either stack today** — no CloudWatch Alarms, no SNS topics, nothing that pages or emails anyone when something breaks. Everything below is a manual/reactive check, not a push notification. If you want proactive alerting (e.g. "page someone when the DLQ has messages," "alert if SYNC_FAILED count exceeds N"), that's new Terraform work, not something to assume is already wired up.

What's there to look at manually:

- **CloudWatch Log Groups**: `/aws/lambda/<project>-<env>-request-api` and `/aws/lambda/<project>-<env>-gitops` (30-day retention on both). This is where every request, retry, and failure gets logged with a `[TAG]`-prefixed message (`[QUEUE]`, `[RETRY]`, `[SWEEP]`, `[NOTIFY]`, `[FAILURE]`, `[IDEMPOTENT]`, `[REVIEWERS]` — grep for these to filter by concern).
- **The DLQ** (if `enable_gitops_dlq = true`, the default): an SQS queue named `<project>-<env>-gitops-dlq`. A message here means a GitOps action exhausted every retry — in-function retries, the scheduled sweep, *and* Lambda's own built-in async retries. A non-empty DLQ is worth investigating even though nothing will alert you to it automatically.
- **The sweep rule**: `<project>-<env>-gitops-sweep`, an EventBridge rule firing every 10 minutes by default. Its executions and any failures show up in the gitops Lambda's own log group (search for `[SWEEP]`) — there's no separate log for the rule itself.
- **DynamoDB**: `PAY_PER_REQUEST` billing, so throttling is unlikely under normal load but not impossible under a sudden burst — check the table's CloudWatch metrics (`ThrottledRequests`) if things seem slow.

## Day-2 operations

**Rotating the git-host token.** Update the value in Secrets Manager directly (`bitbucket-token` / `github-token`, or whatever the literal in `handler.py` currently says) — no Terraform apply needed, the Lambda reads it fresh on every cold start via `sm.get_secret_value`. Old warm Lambda instances may keep using a cached token in memory until they recycle; if you need the rotation to take effect immediately everywhere, publish a no-op update to force new execution environments (or just wait — Lambda recycles instances routinely).

**Adding a new market.** This lives entirely on the frontend config side — add the market to `VITE_AVAILABLE_MARKETS` in `.env` (`CODE:Name` format) and, if it's genuinely new to the config repo, make sure `values.dev.yaml`/`values.qa.yaml`/`values.prd.yaml` exist for it under `repo_base_path/<market>/` (or let the first request against it create them — check `process_yaml_updates`'s behavior in the [Comprehensive Documentation](./portal-comprehensive-documentation.md) if you're unsure whether it creates missing files).

**Unsticking a queued or stuck-promotion request.** Both are admin-only UI actions on the Request Details page — "Force release market lock" for a `QUEUED` request stuck behind a dead one, "Retry promotion" for a request that merged but never got a promotion PR opened for the next stage. See the [User Handbook](./user-handbook.md) for what each does from a user's perspective. There is currently **no equivalent manual action for `SYNC_FAILED`** — that one only ever recovers via the automatic sweep (every 10 minutes, up to 5 attempts).

**Redeploying after a code change.** `terraform apply` — the Lambda's zip is rebuilt from the local `lambda/`/`lambda-gitops/` (or their personal-stack equivalents) source directories via `data.archive_file`, and its hash changes trigger a redeploy automatically. There's no separate build/package step to remember.

## Troubleshooting & Incident Playbook

| Symptom | Likely cause | What to do |
|---|---|---|
| Every request immediately fails / GitOps Lambda logs "Bitbucket token is empty" or similar on every invocation | A `REQUIRED` variable is unset (see table above), or the Secrets Manager secret name doesn't match the hardcoded `SecretId` literal in `handler.py` | Check `terraform.tfvars` against the required-variables table; check the secret actually exists under the exact name the code expects |
| A batch of requests sit at `SYNC_FAILED` | Bitbucket/GitHub outage or maintenance window at the time the pipeline tried to reach it | Usually self-resolves via the sweep (every 10 min, up to 5 attempts) — check the gitops Lambda's logs for `[SWEEP]` entries to confirm it's retrying. If it's been stuck well beyond a few sweep cycles, check whether `sync_failure_count` has hit the cap (`SYNC_MAX_AUTO_RETRIES = 5`) — those show up in the sweep's own return value as `requests_skipped_cap` |
| A request sits at `QUEUED` far longer than expected | The request holding that market's lock is itself stuck (e.g. also `SYNC_FAILED`, or an approver never acted) | Automatic: the lock self-releases after `market_lock_stale_seconds` (default 24h). Faster: an admin can use "Force release market lock" on the queued request's detail page once they've confirmed the blocking request is genuinely dead |
| A request merged into a stage but no promotion PR ever appeared for the next one | The `LOCK#<market>#<branch>` guarding that promotion got orphaned — usually because an earlier promotion PR to that same branch pair was resolved outside the portal (closed/merged directly on the git host rather than through the webhook) | An admin can use "Retry promotion" on that request's detail page — it drops the orphaned lock (and its `PR#<id>` lookup item) and re-claims a clean one |
| A request looks "done" (its work is merged everywhere) but never shows `COMPLETED` | See [How Requests Become Completed](#how-requests-become-completed) above — completion requires the *final* target stage's webhook to actually fire; a missed/delayed webhook or an orphaned lock can leave it one step short | Confirm the last stage's PR is actually merged on the git host (not just approved); if so and status still hasn't advanced, use "Retry promotion" to re-drive it |
| Frontend gets CORS errors calling the API | The frontend's actual origin isn't in `cors_allow_origins` on the deployed stack — most often after moving the frontend to a new domain/port without updating the backend | `terraform apply -var='cors_allow_origins=["https://your-actual-origin"]'` (or add it to `terraform.tfvars`) and re-apply |
| `terraform apply` fails on `sqs:CreateQueue` with an access-denied/SCP error | Some AWS orgs block SQS queue creation via a Service Control Policy | Set `enable_gitops_dlq = false` — the scheduled sweep's automatic recovery doesn't depend on the DLQ at all; you only lose the last-resort manual-inspection queue for an item that exhausted every retry layer |
| `terraform apply`'s `local-exec` provisioner (building the gitops Lambda's dependency layer) fails on Windows | No `pip3`/`pip`/`python`/`py` found on `PATH`, or a shell-quoting issue specific to `cmd.exe`/PowerShell | Confirm Python is installed with "Add to PATH" checked; the provisioner already tries `pip3` → `pip` → `python -m pip` → `py -m pip` in order, so this usually means none of those resolve at all |
| Webhook events never arrive / statuses never advance past PR creation | The webhook registered on the git host doesn't point at the current API's `/dpc/bitbucket/webhook` (or `/dpc/github/webhook`) URL (e.g. after a stack was torn down and rebuilt, the API's invoke URL changes) | Re-run `setup.sh` (it re-registers/updates the webhook idempotently), or check the git host's webhook settings against the current `terraform output`/apply summary |
| Same status appears twice in a request's timeline | **Historically** a duplicate-webhook-delivery bug in `_update_item` (no idempotency guard). **This is fixed** — `_update_item` now conditions its update on the target status actually being new, so a redelivered webhook is a no-op. If you see this again, it's a regression, not the known historical issue | Check `_update_item` in `handler.py` still has the `attribute_not_exists(#s) OR #s <> :s` condition intact |

## Rollback

There is currently **no built-in one-click rollback** — neither Lambda function uses versioning/aliases (`publish = true` + an alias pointing at a specific version), so AWS itself doesn't retain "the previous working code" anywhere once a new zip is deployed. A rollback in practice means: revert the source change in git, then `terraform apply` again to rebuild and redeploy the reverted code. If you anticipate needing faster rollbacks, that's a concrete infrastructure improvement worth scoping separately (Lambda aliases + a deployment that shifts traffic between versions) rather than something to assume works today.

DynamoDB has `point_in_time_recovery` enabled on both stacks, so table-level data recovery (restore to any point in the last 35 days) is available independent of any Lambda rollback.

## Security & secrets handling

This is covered in depth in the Comprehensive Documentation's Known Issues section — summarized here for operational awareness: there is no backend API authentication or per-market authorization enforced today (a plan exists — `sso-backend-auth-implementation-plan.md` — but is not implemented), and the webhook endpoint has no signature verification. Treat both as open risk when deciding how exposed to make either stack's API. The git-host token and any secrets live only in Secrets Manager — never in Terraform variables' defaults, never committed to the repo.

## Reference

- Full technical detail: [Comprehensive Documentation](./portal-comprehensive-documentation.md) and the [Documentation Index](./portal-documentation-index.md).
- Day-to-day usage from a requester's point of view: [User Handbook](./user-handbook.md).
- Known gaps and what's planned: see the Comprehensive Documentation's Known Issues & Roadmap section.
- A prior, more narrative "Documentation & Operations Runbook" (.docx, 18 pages) was delivered directly in an earlier session (2026-09-03) but never landed in this project's knowledge base (an upload error at the time) and predates several changes covered here (the per-market queueing GSI, the Current Whitelist page, the duplicate-history-entry fix, the PR-reviewer-assignment removal). This doc supersedes it for anything the two disagree on.
