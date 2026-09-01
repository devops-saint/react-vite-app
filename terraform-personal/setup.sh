#!/usr/bin/env bash
# One-command setup for the personal (GitHub-backed) test stack:
# creates the GitHub token secret, scaffolds the config repo if it's
# empty, writes terraform.tfvars, applies Terraform, registers the
# GitHub webhook, and writes ../.env.personal - everything after "you
# have a GitHub PAT in hand" is automated. Re-running is safe (every
# step checks before it creates/overwrites).
#
# USAGE:
#   cd terraform-personal
#   GITHUB_OWNER=devops-saint \
#   GITHUB_REPO=test-repo \
#   GITHUB_TOKEN=ghp_xxx \
#   ./setup.sh
#
#   Add -y (or AUTO_APPROVE=1) to skip the terraform apply confirmation
#   prompt for fully unattended runs:
#     ./setup.sh -y
#
# REQUIRED environment variables:
#   GITHUB_OWNER   GitHub username or org that owns the config repo
#   GITHUB_REPO    Name of the (already-created, empty) config repo
#   GITHUB_TOKEN   PAT with Contents + Pull requests + Webhooks
#                  read/write on that repo. Cannot be created by this
#                  script - GitHub has no API to mint a PAT without one
#                  already existing. Create it at
#                  https://github.com/settings/tokens (classic, scope
#                  "repo") or as a fine-grained token scoped to the
#                  repo with Contents, Pull requests, and Webhooks set
#                  to Read and write.
#
# OPTIONAL environment variables (sensible defaults shown):
#   REPO_BASE_PATH          markets
#   MARKETS                 "UK US"     (space-separated market codes)
#   AWS_REGION              eu-west-1
#   GITHUB_TOKEN_SECRET_NAME github-token
#   PR_APPROVER_USERNAMES   ""          (comma-separated)
#   PR_APPROVER_EMAILS      ""          (comma-separated)
#   DOMAIN                  ""          (verified SES domain; leave
#                                        empty to keep notifications off)
#
# PREREQUISITE (manual, one-time, via github.com UI - no `gh` CLI
# needed): create an empty repo at https://github.com/new - do NOT
# initialize it with a README/.gitignore/license.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

AUTO_APPROVE="${AUTO_APPROVE:-0}"
for arg in "$@"; do
  if [ "$arg" = "-y" ] || [ "$arg" = "--auto-approve" ]; then
    AUTO_APPROVE=1
  fi
done

echo "==> Checking prerequisites"
for cmd in terraform aws git curl python3 node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

: "${GITHUB_OWNER:?Set GITHUB_OWNER to the GitHub username or org that owns the config repo}"
: "${GITHUB_REPO:?Set GITHUB_REPO to the name of the empty config repo you created}"
: "${GITHUB_TOKEN:?Set GITHUB_TOKEN to a PAT with repo + webhook read/write}"

REPO_BASE_PATH="${REPO_BASE_PATH:-markets}"
MARKETS="${MARKETS:-UK US}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
GITHUB_TOKEN_SECRET_NAME="${GITHUB_TOKEN_SECRET_NAME:-github-token}"
PR_APPROVER_USERNAMES="${PR_APPROVER_USERNAMES:-}"
PR_APPROVER_EMAILS="${PR_APPROVER_EMAILS:-}"
DOMAIN="${DOMAIN:-}"

GITHUB_API="https://api.github.com"
AUTH_HEADER="Authorization: Bearer ${GITHUB_TOKEN}"

json_get() {
  # json_get <python-expression-on-`data`> reads JSON from stdin.
  python3 -c "import json,sys; data=json.load(sys.stdin); print($1)"
}

hcl_list() {
  # hcl_list <comma-separated-string> -> a valid HCL list literal, e.g.
  # 'jdoe,asmith' -> ["jdoe", "asmith"]; '' -> [] (not [""]).
  python3 -c "
import sys
items = [x.strip() for x in sys.argv[1].split(',') if x.strip()]
print('[' + ', '.join(f'\"{x}\"' for x in items) + ']')
" "$1"
}

echo "==> Verifying GitHub token can see ${GITHUB_OWNER}/${GITHUB_REPO}"
repo_check_status="$(curl -s -o /tmp/gh_repo_check.json -w '%{http_code}' \
  -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" \
  "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}")"
if [ "$repo_check_status" != "200" ]; then
  echo "Could not read ${GITHUB_OWNER}/${GITHUB_REPO} with this token (HTTP $repo_check_status)." >&2
  echo "Confirm the repo exists and the token has access to it." >&2
  exit 1
fi

echo "==> Storing the GitHub token in Secrets Manager (${GITHUB_TOKEN_SECRET_NAME})"
if aws secretsmanager describe-secret --secret-id "$GITHUB_TOKEN_SECRET_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "$GITHUB_TOKEN_SECRET_NAME" \
    --secret-string "$GITHUB_TOKEN" \
    --region "$AWS_REGION" >/dev/null
  echo "    updated existing secret"
else
  aws secretsmanager create-secret \
    --name "$GITHUB_TOKEN_SECRET_NAME" \
    --secret-string "$GITHUB_TOKEN" \
    --region "$AWS_REGION" >/dev/null
  echo "    created new secret"
fi

echo "==> Checking whether ${GITHUB_OWNER}/${GITHUB_REPO} already has a dev branch"
dev_branch_status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" \
  "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/branches/dev")"
if [ "$dev_branch_status" = "200" ]; then
  echo "    dev branch already exists - skipping scaffold (repo already set up)"
else
  echo "    scaffolding dev/qa/master branches with initial values.<env>.yaml files"
  REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git" \
  REPO_BASE_PATH="$REPO_BASE_PATH" \
  MARKETS="$MARKETS" \
    ./scaffold-config-repo.sh
fi

echo "==> Writing terraform.tfvars"
if [ -f terraform.tfvars ]; then
  echo "    terraform.tfvars already exists - leaving it as-is (delete it first to regenerate)"
else
  cat > terraform.tfvars <<TFVARS
aws_region   = "${AWS_REGION}"
project_name = "dpc-whitelisting-personal"
environment  = "dev"

github_owner   = "${GITHUB_OWNER}"
github_repo    = "${GITHUB_REPO}"
repo_base_path = "${REPO_BASE_PATH}"

github_token_secret_name = "${GITHUB_TOKEN_SECRET_NAME}"

domain = "${DOMAIN}"

pr_approver_usernames = $(hcl_list "$PR_APPROVER_USERNAMES")
pr_approver_emails    = $(hcl_list "$PR_APPROVER_EMAILS")

cors_allow_origins = ["http://localhost:3000", "http://localhost:5173"]
TFVARS
  echo "    wrote terraform.tfvars"
fi

echo "==> terraform init"
terraform init -input=false

echo "==> terraform apply"
if [ "$AUTO_APPROVE" = "1" ]; then
  terraform apply -input=false -auto-approve
else
  terraform apply -input=false
fi

API_BASE_URL="$(terraform output -raw api_base_url)"
WEBHOOK_URL="$(terraform output -raw github_webhook_url)"
DLQ_URL="$(terraform output -raw gitops_dlq_url)"
SWEEP_RULE="$(terraform output -raw gitops_sweep_rule_name)"

echo "==> Registering the GitHub webhook (pull_request, pull_request_review, issue_comment)"
existing_hook_id="$(curl -s -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" \
  "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/hooks" \
  | json_get "next((str(h['id']) for h in data if h.get('config',{}).get('url') == '${WEBHOOK_URL}'), '')")"

hook_payload=$(python3 -c '
import json
print(json.dumps({
    "name": "web",
    "active": True,
    "events": ["pull_request", "pull_request_review", "issue_comment"],
    "config": {"url": "'"${WEBHOOK_URL}"'", "content_type": "json"},
}))
')

if [ -n "$existing_hook_id" ]; then
  curl -s -X PATCH \
    -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" \
    -d "$hook_payload" \
    "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/hooks/${existing_hook_id}" >/dev/null
  echo "    updated existing webhook (id $existing_hook_id) to the current event set"
else
  create_status="$(curl -s -o /tmp/gh_hook_create.json -w '%{http_code}' -X POST \
    -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" \
    -d "$hook_payload" \
    "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/hooks")"
  if [ "$create_status" != "201" ]; then
    echo "    warning: webhook creation returned HTTP $create_status - check /tmp/gh_hook_create.json and add it manually via GitHub Settings -> Webhooks" >&2
  else
    echo "    created webhook"
  fi
fi

echo "==> Writing ../.env.personal"
cat > ../.env.personal <<ENVFILE
# Generated by terraform-personal/setup.sh - re-run the script to
# regenerate after a Terraform change (e.g. a new api_base_url).

VITE_API_BASE_URL=${API_BASE_URL}/dpc
VITE_REPOSITORY_NAME=${GITHUB_REPO}
VITE_ENVIRONMENT=personal-dev
ENVFILE
echo "    wrote ../.env.personal"

cat <<SUMMARY

==================================================================
Personal stack ready.

  API base URL     : ${API_BASE_URL}
  GitHub webhook    : ${WEBHOOK_URL}
  Failure DLQ (SQS) : ${DLQ_URL}
  Retry sweep rule  : ${SWEEP_RULE}

Next step - from the repo root:
  npm install   (if you haven't already)
  npm run dev:personal

Note: Azure AD SSO settings (VITE_CLIENT_ID etc.) come from the root
.env, which this script does not touch - make sure that's already
filled in from .env.example.
==================================================================
SUMMARY
