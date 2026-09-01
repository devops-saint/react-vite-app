# Org stack setup (Bitbucket Server-backed)

This is the fast path and the full manual path for standing up the org
stack end-to-end: AWS infrastructure, the Bitbucket-side config repo, and
the frontend. It's independent of the personal/GitHub stack in
`../terraform-personal/` - separate AWS resources, separate Lambda code,
separate repo.

If you just want it running, skip to **Option A**. Read **Option B** if you
want to understand (or need to do manually) what the script automates, or if
a step in Option A fails partway and you need to pick up from there.

Unlike the personal stack, the org's Bitbucket config repo typically
**already exists** as a live repository with real history - `setup.sh`
reflects that: it only scaffolds a brand-new empty repo if you explicitly
opt in (`SCAFFOLD_IF_EMPTY=1`), and otherwise just warns if it can't find a
`dev` branch rather than pushing to a repo that might not be yours to
initialize.

## Prerequisites

- An AWS account/credentials with permission to create the resources in
  `main.tf` (DynamoDB, Lambda, API Gateway, IAM, SQS, EventBridge, Secrets
  Manager), and the AWS CLI configured (`aws sts get-caller-identity` works).
- `terraform` (>= the version in `versions.tf`).
- `git`, `curl`, `python3`, `node`/`npm`.
- Access to the org's Bitbucket Server instance and the project/repo that
  holds (or will hold) the per-market config YAML.
- A Bitbucket Server HTTP access token (see step 2 below). This is the one
  thing that can't be scripted - there's no API to mint a token without one
  already existing.

## Option A: automated (`setup.sh`)

1. Confirm the config repo exists in your Bitbucket project (project key +
   repo slug). If it's a genuinely new/empty repo you want this script to
   populate, note that for step 3 (`SCAFFOLD_IF_EMPTY=1`).
2. Create an HTTP access token from the repo's Bitbucket Server settings
   (Repository settings -> HTTP access tokens) with repo admin (for webhook
   registration) and read/write (for branch/PR/file operations) permissions.
   Copy it somewhere you can paste it into a shell in the next step - it is
   never written to a file by this script (see **Where the token goes**
   below).
3. From the repo root:

   ```bash
   cd terraform
   BITBUCKET_URL=https://bitbucket.example.com \
   PROJECT_KEY=<your-project-key> \
   REPO_NAME=<your-repo-slug> \
   BITBUCKET_TOKEN=<the-access-token-from-step-2> \
   ./setup.sh
   ```

   Add `-y` (or `AUTO_APPROVE=1`) to skip Terraform's interactive apply
   confirmation for a fully unattended run. Add `SCAFFOLD_IF_EMPTY=1` only
   if step 1 was a brand-new empty repo you want this script to populate
   with starter `dev`/`qa`/`master` branches.

   Optional variables (all have sensible defaults - see the header comment
   in `setup.sh` for the full list): `REPO_BASE_PATH`, `AWS_REGION`,
   `BITBUCKET_TOKEN_SECRET_NAME`, `PR_APPROVER_USERNAMES`,
   `PR_APPROVER_EMAILS`, `DOMAIN`.

4. The script prints a summary when it finishes (API URL, webhook URL, DLQ
   URL, sweep rule name). It has already updated `../.env` for you (just
   the two keys `VITE_API_BASE_URL` / `VITE_REPOSITORY_NAME` - everything
   else in that file is left alone).
5. Finish the **UI setup** section below (Azure AD values, if `../.env`
   didn't already exist), then `npm run dev`.

What the script does, in order: verifies the token can read the repo,
stores the token in Secrets Manager, checks for a `dev` branch and
optionally scaffolds one, writes `terraform.tfvars`, runs `terraform init`
+ `terraform apply`, registers the Bitbucket webhook (creating it or
updating an existing one to the current event set), and updates `../.env`
in place. Every step checks before it creates or overwrites, so re-running
`setup.sh` after a Terraform change (to pick up a new output) or a manual
`terraform apply` is safe and cheap - it won't duplicate the secret,
re-scaffold branches, clobber a hand-edited `terraform.tfvars`, or create a
second webhook.

### Where the token goes

`BITBUCKET_TOKEN` is read from the environment, used directly in `curl`
Authorization headers and one `aws secretsmanager` call, and then only ever
exists at rest inside AWS Secrets Manager. `setup.sh` never writes it to a
file anywhere in the repo. The generated `terraform.tfvars` contains no
token - only the *name* of the secret Lambda should read at runtime. See
**Sensitive data / what never gets committed** below for the full picture.

## Option B: manual, step by step

Use this if you want to understand each piece, or if you're resuming after
`setup.sh` failed partway.

1. **Config repo.** Confirm it exists in Bitbucket. Only if it's genuinely
   empty and yours to initialize:

   ```bash
   cd terraform
   REPO_URL=https://x-token-auth:<access-token>@bitbucket.example.com/scm/<PROJECT_KEY>/<repo-slug>.git \
   REPO_BASE_PATH=markets \
   MARKETS="UK US" \
   ./scaffold-config-repo.sh
   ```

   This creates `dev`, `qa`, and `master` branches, each with
   `<REPO_BASE_PATH>/<market>/values.{dev,qa,prd}.yaml` files (starting
   content `{buckets: [], secrets: [], kmsKeys: [], functions: []}`) -
   matching the layout `lambda-gitops/handler.py` reads and writes via
   `process_yaml_updates`.

2. **Token in Secrets Manager.** Create the token (see Option A step 2),
   then:

   ```bash
   aws secretsmanager create-secret \
     --name bitbucket-token \
     --secret-string <the-token> \
     --region eu-west-1
   ```

   (`bitbucket-token` is the default `bitbucket_token_secret_name`; use
   `put-secret-value` instead of `create-secret` if the secret already
   exists.)

3. **`terraform.tfvars`.** Copy `terraform.tfvars.example` to
   `terraform.tfvars` and fill in `bitbucket_url`, `project_key`,
   `repo_name`, `repo_base_path` (must match step 1's `REPO_BASE_PATH`).
   Leave `domain = ""` unless you have a verified SES domain - every
   notification function no-ops cleanly when it's unset.

4. **Deploy.**

   ```bash
   terraform init
   terraform apply
   ```

5. **Webhook.** Build the webhook URL as `<api_base_url output>` +
   `/dpc/bitbucket/webhook`, and add it under the repo's Settings ->
   Webhooks: content type `application/json`, and subscribe to the PR
   lifecycle events the Lambda listens for -
   `pr:opened`, `pr:modified`, `pr:merged`, `pr:declined`, `pr:deleted`,
   `pr:reviewer:approved`, `pr:reviewer:needs_work` (see `EVENT_STATUS` in
   `lambda/handler.py`).

6. **Frontend env.** Take the `api_base_url` output and set in `../.env`:

   ```
   VITE_API_BASE_URL=<api_base_url>/dpc
   VITE_REPOSITORY_NAME=<repo-slug>
   ```

   (leave every other key in `../.env` as-is.)

## UI setup

The frontend is shared between both stacks; only the API endpoint and repo
name differ. Plain `npm run dev` (no mode flag) loads only `../.env`, which
is exactly what this stack needs - no separate mode/env file, unlike the
personal stack's `.env.personal` overlay.

1. If `../.env` doesn't exist yet, copy `../.env.example` to `../.env` and
   fill in the Azure AD values (`VITE_CLIENT_ID`, `VITE_TENANT_ID`,
   `VITE_REDIRECT_URI`) from your Azure App registration. This step is
   manual by necessity - there's no API to mint an Azure AD app
   registration from a script.
2. `VITE_API_BASE_URL` and `VITE_REPOSITORY_NAME` are written for you by
   `setup.sh` (or step 6 above); every other key is left untouched.
3. From the repo root:

   ```bash
   npm install   # first time only
   npm run dev
   ```

4. To point the running UI at the personal stack instead, use
   `npm run dev:personal` in the same checkout - no infrastructure change
   needed, it's purely which `.env` file(s) Vite loads.

## Resilience features (Bitbucket/network outages)

This stack retries transient Bitbucket failures automatically
(`_request_with_retry` in `lambda-gitops/handler.py`: 3 attempts, backoff
on `429`/`5xx`), and is idempotent on retry (re-running a branch or PR
creation that already succeeded is a no-op, not a duplicate - Bitbucket
Server signals "already exists" with `409`, and a duplicate-PR `409` often
embeds the existing PR directly in the error body, avoiding an extra
lookup call). If Bitbucket is down long enough that all retries -
including Lambda's own built-in async retries - are exhausted, the
affected request is marked `SYNC_FAILED` (or a stuck promotion lock is
marked `FAILED`) rather than silently disappearing, and:

- A message lands in the `gitops_dlq_url` SQS queue (from the output / the
  script's summary) as a last-resort signal worth checking manually.
- An EventBridge rule (`gitops_sweep_rule_name`, default every 10 minutes)
  automatically retries `SYNC_FAILED` requests and stuck `FAILED`/orphaned
  promotion locks with no extra action needed - most outages resolve
  themselves once Bitbucket is back, without anyone re-submitting anything.

Note: unlike the personal/GitHub stack, decline/approve reasons left as PR
comments are **not yet** surfaced in the portal UI for Bitbucket - that was
built only for GitHub's `issue_comment` webhook event this pass. This
stack's PR status still updates correctly on decline/approve; only the
free-text comment itself doesn't show up in the UI yet.

## Sensitive data / what never gets committed

- The Bitbucket access token is never written to a file in this repo at
  any point - it's read from the `BITBUCKET_TOKEN` environment variable,
  used in-memory for API calls and the one `aws secretsmanager` write, then
  discarded. At rest it lives only in AWS Secrets Manager.
- `terraform.tfvars` (real values) is gitignored; only
  `terraform.tfvars.example` (no secrets, just placeholders) is tracked.
  See `terraform/.gitignore`.
- `*.tfstate`/`*.tfstate.backup` are gitignored, even though Terraform state
  can contain resource attributes you wouldn't want in git history.
- `../.env` (real values, including Azure AD client info) is gitignored at
  the repo root; only `.env.example` is tracked.
- `__pycache__/` and `*.pyc` (regenerated by any local Python run of the
  Lambda handlers) are gitignored.
- Run `git status --short` after following this guide - only
  `terraform.tfvars.example`-style templates, source `.tf`/`.py`/`.sh`
  files, and this doc should show as new/changed. If you ever see
  `terraform.tfvars`, `.env`, or `*.tfstate` in that output, stop and check
  `.gitignore` before committing.

## Troubleshooting

- **GitOps Lambda fails on every invocation**: `bitbucket_url`,
  `project_key`, `repo_name`, or `repo_base_path` is unset in
  `terraform.tfvars` - these have no default and the Lambda checks for
  them explicitly.
- **A request is stuck / never got a PR**: check the `gitops_sweep_rule_name`
  EventBridge rule is enabled, and check the `gitops_dlq_url` queue for a
  message - it means retries were exhausted, which usually means the token
  expired/was revoked rather than a transient outage.
- **`setup.sh` warns "no dev branch found" and doesn't scaffold**: this is
  intentional for the org stack - either populate the repo yourself, or
  confirm you're allowed to initialize it and re-run with
  `SCAFFOLD_IF_EMPTY=1`.
- **`terraform apply` asks about resources you didn't expect**: you may be
  in the wrong directory - this stack's state is entirely separate from
  `../terraform-personal/`'s.
