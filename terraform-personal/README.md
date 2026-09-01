# Personal test stack (GitHub-backed, parallel to org Bitbucket setup)

**Full setup guide (fast-path script + manual steps + UI setup): see [`SETUP.md`](./SETUP.md).**

Lets you test the full promotion pipeline (dev -> qa -> master) end-to-end
against a personal GitHub repo, without touching or risking the org's live
Bitbucket-backed deployment (`../terraform/`). Fully separate Lambda code,
Terraform, and AWS resources - nothing shared with org except the AWS
account/region.

## What's here

- `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`,
  `terraform.tfvars.example` - standalone Terraform root module,
  parameterized via `project_name = "dpc-whitelisting-personal"`.
  Provisions its own DynamoDB table, 2 Lambdas, API Gateway, IAM roles.
- `lambda-personal/handler.py` - GitHub-flavored request-api Lambda.
  ~95% code reused verbatim from org's `../terraform/lambda/handler.py`
  (`compute_target_stages`, `advance_stage`, `trigger_promotion`,
  `handle_stage_event`, etc.). Only `handle_webhook` is new: normalizes
  GitHub's `pull_request` / `pull_request_review` payloads into the same
  internal event-key vocabulary org's Bitbucket path uses (`pr:opened`,
  `pr:merged`, etc.) before calling the shared `handle_stage_event`.
  Route: `POST /dpc/github/webhook` (reads the `x-github-event` header).
- `lambda-gitops-personal/handler.py` - GitHub-flavored GitOps Lambda.
  GitHub REST API equivalents of org's Bitbucket calls (branch create,
  file get/commit via base64+sha, PR create, requested reviewers). Reads
  a GitHub PAT from Secrets Manager (`SecretId="github-token"` by
  default, matches the `github_token_secret_name` variable).
- `scaffold-config-repo.sh` - one-shot script that creates `dev`/`qa`/
  `master` branches on an empty personal GitHub repo, seeding
  `<REPO_BASE_PATH>/<market>/values.{dev,qa,prd}.yaml` (each
  `{buckets: [], secrets: [], kmsKeys: [], functions: []}`) identically
  on all three branches - matches org's
  `REPO_BASE_PATH/{market}/values.{env}.yaml` layout exactly (see
  `../terraform/lambda-gitops/handler.py`'s `process_yaml_updates`).
- `.gitignore` - mirrors org's `../terraform/.gitignore`
  (`.terraform/`, `*.tfstate*`, `.build/`).

Frontend-side: `../.env.personal` overrides just `VITE_API_BASE_URL` and
`VITE_REPOSITORY_NAME`; everything else (Azure AD, routes, markets) is
inherited from the existing `../.env`. Run via `npm run dev:personal`
(`vite --mode personal`), added to `../package.json`.

Promotion mechanics (LOCK#/PR# DynamoDB items, `advance_stage`,
branch-to-branch merge PRs with no new commits) are unchanged from the
design already applied to org's two Lambdas - see the "Promotion Rails"
diagram: https://claude.ai/code/artifact/3529aec8-6f91-4513-a007-75c4f1904149

## No-domain / no-SES constraint

No verified SES domain is available for personal testing. No code changes
were needed for this: every `notify_*` function in both org and personal
Lambdas already guards on the sender domain being unset and no-ops
cleanly. `terraform.tfvars.example` ships with `domain = ""` and a
comment explaining this is intentional, not an oversight.

## Setup steps

1. Create an empty personal GitHub repo via github.com (no README/
   .gitignore - the scaffold script creates the initial commit). No `gh`
   CLI required.
2. Run `./scaffold-config-repo.sh` with `REPO_URL` set (and optionally
   `REPO_BASE_PATH` / `MARKETS`):
   ```
   REPO_URL=git@github.com:<you>/aws-whitelist-config-personal.git \
   REPO_BASE_PATH=markets \
   MARKETS="UK US" \
   ./scaffold-config-repo.sh
   ```
3. Create a GitHub PAT (classic `repo` scope, or fine-grained with
   Contents + Pull requests read/write on the config repo) and store it
   in AWS Secrets Manager under the name matching
   `github_token_secret_name` (default `github-token`).
4. Copy `terraform.tfvars.example` -> `terraform.tfvars`, fill in
   `github_owner`, `github_repo`, `repo_base_path` (must match step 2),
   leave `domain = ""`.
5. `terraform init && terraform apply` from this directory.
6. Take the `api_base_url` output, append `/dpc`, put it in
   `../.env.personal` as `VITE_API_BASE_URL`.
7. Take the `github_webhook_url` output and add it as a webhook on the
   personal config repo (Settings -> Webhooks; content type
   `application/json`; events: Pull requests + Pull request reviews).
8. `npm run dev:personal` (from the repo root) to run the frontend
   against the personal stack.

## Verification performed when this stack was built

- All 4 Lambda handlers (org's 2 + personal's 2) compiled clean
  (`python3 -m py_compile`).
- All `.tf` files here are brace/paren-balanced.
- Every file was MD5-verified byte-identical after transfer.
- `git status` showed only the intended diff (`.gitignore`,
  `package.json` modified; `terraform-personal/` new) - no org files
  touched, no deletions.
