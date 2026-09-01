# Personal stack setup (GitHub-backed)

This is the fast path and the full manual path for standing up the personal
test stack end-to-end: AWS infrastructure, the GitHub-side config repo, and
the frontend. It's independent of the org/Bitbucket stack in `../terraform/`
- separate AWS resources, separate Lambda code, separate repo.

If you just want it running, skip to **Option A**. Read **Option B** if you
want to understand (or need to do manually) what the script automates, or if
a step in Option A fails partway and you need to pick up from there.

## Prerequisites

- An AWS account/credentials with permission to create the resources in
  `main.tf` (DynamoDB, Lambda, API Gateway, IAM, SQS, EventBridge, Secrets
  Manager), and the AWS CLI configured (`aws sts get-caller-identity` works).
- `terraform` (>= the version in `versions.tf`).
- `git`, `curl`, `python3`, `node`/`npm`.
- A GitHub account you're happy to create a test repo under. This can be the
  same account as the org stack or a separate personal one - they don't
  interact.
- A GitHub PAT (see step 2 below). This is the one thing that can't be
  scripted - GitHub has no API to mint a token without one already existing.

## Option A: automated (`setup.sh`)

1. Create an empty GitHub repo at <https://github.com/new>. Do **not**
   initialize it with a README/.gitignore/license - the automation expects
   to create the first commit itself.
2. Create a PAT at <https://github.com/settings/tokens>: either a classic
   token with the `repo` scope, or a fine-grained token scoped to just that
   repo with **Contents**, **Pull requests**, and **Webhooks** set to Read
   and write. Copy it somewhere you can paste it into a shell in the next
   step - it is never written to a file by this script (see
   **Where the token goes** below).
3. From the repo root:

   ```bash
   cd terraform-personal
   GITHUB_OWNER=<your-github-username-or-org> \
   GITHUB_REPO=<the-empty-repo-you-just-created> \
   GITHUB_TOKEN=<the-PAT-from-step-2> \
   ./setup.sh
   ```

   Add `-y` (or `AUTO_APPROVE=1`) to skip Terraform's interactive apply
   confirmation for a fully unattended run.

   Optional variables (all have sensible defaults - see the header comment
   in `setup.sh` for the full list): `REPO_BASE_PATH`, `MARKETS`,
   `AWS_REGION`, `GITHUB_TOKEN_SECRET_NAME`, `PR_APPROVER_USERNAMES`,
   `PR_APPROVER_EMAILS`, `DOMAIN`.

4. The script prints a summary when it finishes (API URL, webhook URL, DLQ
   URL, sweep rule name). It has already written `../.env.personal` for
   you.
5. Finish the **UI setup** section below (Azure AD values - the one part
   that stays manual), then `npm run dev:personal`.

What the script does, in order: verifies the token can read the repo,
stores the token in Secrets Manager, scaffolds `dev`/`qa`/`master` branches
with starter `values.<env>.yaml` files if the repo has no `dev` branch yet,
writes `terraform.tfvars`, runs `terraform init` + `terraform apply`,
registers the GitHub webhook (creating it or updating an existing one to the
current event set), and writes `../.env.personal`. Every step checks before
it creates or overwrites, so re-running `setup.sh` after a Terraform change
(to pick up a new output) or a manual `terraform apply` is safe and cheap -
it won't duplicate the secret, re-scaffold branches, clobber a
hand-edited `terraform.tfvars`, or create a second webhook.

### Where the token goes

`GITHUB_TOKEN` is read from the environment, used directly in `curl`
Authorization headers and one `aws secretsmanager` call, and then only ever
exists at rest inside AWS Secrets Manager. `setup.sh` never writes it to a
file anywhere in the repo. The generated `terraform.tfvars` contains no
token - only the *name* of the secret Lambda should read at runtime. See
**Sensitive data / what never gets committed** below for the full picture.

## Option B: manual, step by step

Use this if you want to understand each piece, or if you're resuming after
`setup.sh` failed partway.

1. **Config repo.** Create an empty GitHub repo (see step 1 above). If it
   has no branches yet, scaffold it:

   ```bash
   cd terraform-personal
   REPO_URL=https://x-access-token:<PAT>@github.com/<owner>/<repo>.git \
   REPO_BASE_PATH=markets \
   MARKETS="UK US" \
   ./scaffold-config-repo.sh
   ```

   This creates `dev`, `qa`, and `master` branches, each with
   `<REPO_BASE_PATH>/<market>/values.{dev,qa,prd}.yaml` files (starting
   content `{buckets: [], secrets: [], kmsKeys: [], functions: []}`) -
   matching the layout `lambda-gitops-personal/handler.py` reads and writes.

2. **PAT in Secrets Manager.** Create the PAT (see Option A step 2), then:

   ```bash
   aws secretsmanager create-secret \
     --name github-token \
     --secret-string <the-PAT> \
     --region eu-west-1
   ```

   (`github-token` is the default `github_token_secret_name`; use
   `put-secret-value` instead of `create-secret` if the secret already
   exists.)

3. **`terraform.tfvars`.** Copy `terraform.tfvars.example` to
   `terraform.tfvars` and fill in `github_owner`, `github_repo`,
   `repo_base_path` (must match step 1's `REPO_BASE_PATH`). Leave
   `domain = ""` unless you have a verified SES domain - every
   notification function no-ops cleanly when it's unset.

4. **Deploy.**

   ```bash
   terraform init
   terraform apply
   ```

5. **Webhook.** Take the `github_webhook_url` output and add it under the
   config repo's Settings -> Webhooks -> Add webhook: content type
   `application/json`, and subscribe to **Pull requests**, **Pull request
   reviews**, and **Issue comments** (the last one is what lets a
   decline/approve comment left on a PR show up in the portal UI - see
   `lambda-personal/handler.py`'s `handle_issue_comment`).

6. **Frontend env.** Take the `api_base_url` output and write
   `../.env.personal`:

   ```
   VITE_API_BASE_URL=<api_base_url>/dpc
   VITE_REPOSITORY_NAME=<github_repo>
   VITE_ENVIRONMENT=personal-dev
   ```

## UI setup

The frontend is shared between both stacks; only the API endpoint and repo
name differ. `../.env` holds everything common to both (Azure AD, routes,
markets); `../.env.personal` overrides just the two values above, and Vite
merges them when run with `--mode personal` (later file wins). Running
plain `npm run dev` - no mode flag - only loads `../.env`, so it targets the
org stack, not this one.

1. If `../.env` doesn't exist yet, copy `../.env.example` to `../.env` and
   fill in the Azure AD values (`VITE_CLIENT_ID`, `VITE_TENANT_ID`,
   `VITE_REDIRECT_URI`) from your Azure App registration. This step is
   manual by necessity - there's no API to mint an Azure AD app
   registration from a script, and this file is intentionally untouched by
   `setup.sh` since both stacks share it.
2. `../.env.personal` is written for you by `setup.sh` (or step 6 above).
3. From the repo root:

   ```bash
   npm install   # first time only
   npm run dev:personal
   ```

4. To point the running UI at the org stack instead, just use
   `npm run dev` (no `:personal`) in the same checkout - no rebuild of
   infrastructure needed, it's purely which `.env` file(s) Vite loads.

## Resilience features (GitHub/network outages)

This stack retries transient GitHub failures automatically
(`_request_with_retry` in `lambda-gitops-personal/handler.py`: 3 attempts,
backoff on `429`/`5xx`), and is idempotent on retry (re-running a branch or
PR creation that already succeeded is a no-op, not a duplicate). If GitHub
is down long enough that all retries - including Lambda's own built-in
async retries - are exhausted, the affected request is marked
`SYNC_FAILED` (or a stuck promotion lock is marked `FAILED`) rather than
silently disappearing, and:

- A message lands in the `gitops_dlq_url` SQS queue (from the output / the
  script's summary) as a last-resort signal worth checking manually.
- An EventBridge rule (`gitops_sweep_rule_name`, default every 10 minutes)
  automatically retries `SYNC_FAILED` requests and stuck `FAILED`/orphaned
  promotion locks with no extra action needed - most outages resolve
  themselves once GitHub is back, without anyone re-submitting anything.

## Sensitive data / what never gets committed

- The GitHub PAT is never written to a file in this repo at any point -
  it's read from the `GITHUB_TOKEN` environment variable, used in-memory
  for API calls and the one `aws secretsmanager` write, then discarded. At
  rest it lives only in AWS Secrets Manager.
- `terraform.tfvars` (real values) is gitignored; only
  `terraform.tfvars.example` (no secrets, just placeholders) is tracked.
  See `terraform-personal/.gitignore`.
- `*.tfstate`/`*.tfstate.backup` are gitignored, even though Terraform state
  can contain resource attributes you wouldn't want in git history.
- `../.env` and `../.env.personal` (real values, including Azure AD client
  info) are gitignored at the repo root; only `.env.example` is tracked.
- `__pycache__/` and `*.pyc` (regenerated by any local Python run of the
  Lambda handlers) are gitignored.
- Run `git status --short` after following this guide - only
  `terraform.tfvars.example`-style templates, source `.tf`/`.py`/`.sh`
  files, and this doc should show as new/changed. If you ever see
  `terraform.tfvars`, `.env`, `.env.personal`, or `*.tfstate` in that
  output, stop and check `.gitignore` before committing.

## Troubleshooting

- **GitOps Lambda fails on every invocation**: `github_owner`,
  `github_repo`, or `repo_base_path` is unset in `terraform.tfvars` - these
  have no default and the Lambda checks for them explicitly.
- **A request is stuck / never got a PR**: check the `gitops_sweep_rule_name`
  EventBridge rule is enabled, and check the `gitops_dlq_url` queue for a
  message - it means retries were exhausted, which usually means the PAT
  expired/was revoked rather than a transient outage.
- **Decline/approve comments don't show up in the UI**: confirm the webhook
  is subscribed to **Issue comments**, not just Pull requests - `setup.sh`
  and Option B step 5 both include it, but a webhook created before this
  session's `issue_comment` feature was added won't have it until you
  re-run `setup.sh` (it updates an existing webhook's event list) or add it
  manually.
- **`terraform apply` asks about resources you didn't expect**: you may be
  in the wrong directory - this stack's state is entirely separate from
  `../terraform/`'s.
