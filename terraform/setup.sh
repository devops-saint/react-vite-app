#!/usr/bin/env bash
# One-command setup for the org (Bitbucket Server-backed) stack:
# creates the Bitbucket token secret, writes terraform.tfvars, applies
# Terraform, and registers the Bitbucket webhook - everything after
# "you have a Bitbucket HTTP access token and an existing config repo"
# is automated. Re-running is safe (every step checks before it
# creates/overwrites).
#
# USAGE:
#   cd terraform
#   BITBUCKET_URL=https://bitbucket.example.com \
#   PROJECT_KEY=DPC \
#   REPO_NAME=aws-whitelist-config \
#   BITBUCKET_TOKEN=xxxx \
#   ./setup.sh
#
#   Add -y (or AUTO_APPROVE=1) to skip the terraform apply confirmation
#   prompt for fully unattended runs:
#     ./setup.sh -y
#
# REQUIRED environment variables:
#   BITBUCKET_URL    Base URL of the Bitbucket Server instance, e.g.
#                    https://bitbucket.example.com
#   PROJECT_KEY      Bitbucket project key that owns the config repo
#   REPO_NAME        Repository slug holding the per-market YAML files
#   BITBUCKET_TOKEN  HTTP access token with repo admin (for webhook
#                    registration) and read/write (for branch/PR/file
#                    operations) on that repo. Cannot be created by
#                    this script - create it from the repo's Bitbucket
#                    Server settings (Repository settings -> HTTP
#                    access tokens) since there is no API to mint a
#                    token without one already existing.
#
# OPTIONAL environment variables (sensible defaults shown):
#   REPO_BASE_PATH            markets
#   AWS_REGION                eu-west-1
#   BITBUCKET_TOKEN_SECRET_NAME bitbucket-token
#   PR_APPROVER_USERNAMES     ""      (comma-separated)
#   PR_APPROVER_EMAILS        ""      (comma-separated)
#   DOMAIN                    ""      (verified SES domain; leave
#                                      empty to keep notifications off)
#   SCAFFOLD_IF_EMPTY         0       set to 1 to auto-run
#                                     scaffold-config-repo.sh when the
#                                     repo has no dev branch yet. Off
#                                     by default since the org repo
#                                     usually already exists with real
#                                     history - the script only warns
#                                     by default rather than pushing to
#                                     it unasked.

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

: "${BITBUCKET_URL:?Set BITBUCKET_URL to the Bitbucket Server base URL}"
: "${PROJECT_KEY:?Set PROJECT_KEY to the Bitbucket project key that owns the config repo}"
: "${REPO_NAME:?Set REPO_NAME to the Bitbucket repository slug}"
: "${BITBUCKET_TOKEN:?Set BITBUCKET_TOKEN to an HTTP access token with repo admin + read/write}"

REPO_BASE_PATH="${REPO_BASE_PATH:-markets}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
BITBUCKET_TOKEN_SECRET_NAME="${BITBUCKET_TOKEN_SECRET_NAME:-bitbucket-token}"
PR_APPROVER_USERNAMES="${PR_APPROVER_USERNAMES:-}"
PR_APPROVER_EMAILS="${PR_APPROVER_EMAILS:-}"
DOMAIN="${DOMAIN:-}"
SCAFFOLD_IF_EMPTY="${SCAFFOLD_IF_EMPTY:-0}"

BITBUCKET_API="${BITBUCKET_URL}/rest/api/latest/projects/${PROJECT_KEY}/repos/${REPO_NAME}"
AUTH_HEADER="Authorization: Bearer ${BITBUCKET_TOKEN}"

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

echo "==> Verifying the token can see ${PROJECT_KEY}/${REPO_NAME}"
repo_check_status="$(curl -s -o /tmp/bb_repo_check.json -w '%{http_code}' -H "$AUTH_HEADER" "$BITBUCKET_API")"
if [ "$repo_check_status" != "200" ]; then
  echo "Could not read ${PROJECT_KEY}/${REPO_NAME} with this token (HTTP $repo_check_status)." >&2
  echo "Confirm the repo exists and the token has access to it." >&2
  exit 1
fi

echo "==> Storing the Bitbucket token in Secrets Manager (${BITBUCKET_TOKEN_SECRET_NAME})"
if aws secretsmanager describe-secret --secret-id "$BITBUCKET_TOKEN_SECRET_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "$BITBUCKET_TOKEN_SECRET_NAME" \
    --secret-string "$BITBUCKET_TOKEN" \
    --region "$AWS_REGION" >/dev/null
  echo "    updated existing secret"
else
  aws secretsmanager create-secret \
    --name "$BITBUCKET_TOKEN_SECRET_NAME" \
    --secret-string "$BITBUCKET_TOKEN" \
    --region "$AWS_REGION" >/dev/null
  echo "    created new secret"
fi

echo "==> Checking whether ${PROJECT_KEY}/${REPO_NAME} already has a dev branch"
dev_branch_found="$(curl -s -H "$AUTH_HEADER" "${BITBUCKET_API}/branches?filterText=dev" \
  | json_get "'yes' if any(b['displayId'] == 'dev' for b in data.get('values', [])) else 'no'")"
if [ "$dev_branch_found" = "yes" ]; then
  echo "    dev branch already exists - skipping scaffold"
elif [ "$SCAFFOLD_IF_EMPTY" = "1" ]; then
  echo "    scaffolding dev/qa/master branches with initial values.<env>.yaml files"
  bitbucket_host="${BITBUCKET_URL#http://}"
  bitbucket_host="${bitbucket_host#https://}"
  REPO_URL="https://x-token-auth:${BITBUCKET_TOKEN}@${bitbucket_host}/scm/${PROJECT_KEY}/${REPO_NAME}.git" \
  REPO_BASE_PATH="$REPO_BASE_PATH" \
    ./scaffold-config-repo.sh
else
  echo "    WARNING: no dev branch found and SCAFFOLD_IF_EMPTY is not set to 1." >&2
  echo "    The GitOps Lambda will fail until dev/qa/master branches with" >&2
  echo "    ${REPO_BASE_PATH}/<market>/values.<env>.yaml files exist. Either" >&2
  echo "    populate the repo yourself, or re-run with SCAFFOLD_IF_EMPTY=1." >&2
fi

echo "==> Writing terraform.tfvars"
if [ -f terraform.tfvars ]; then
  echo "    terraform.tfvars already exists - leaving it as-is (delete it first to regenerate)"
else
  cat > terraform.tfvars <<TFVARS
aws_region   = "${AWS_REGION}"
project_name = "dpc-whitelisting"
environment  = "dev"

bitbucket_url  = "${BITBUCKET_URL}"
project_key    = "${PROJECT_KEY}"
repo_name      = "${REPO_NAME}"
repo_base_path = "${REPO_BASE_PATH}"

bitbucket_token_secret_name = "${BITBUCKET_TOKEN_SECRET_NAME}"

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
DLQ_URL="$(terraform output -raw gitops_dlq_url)"
SWEEP_RULE="$(terraform output -raw gitops_sweep_rule_name)"
WEBHOOK_URL="${API_BASE_URL}/dpc/bitbucket/webhook"

echo "==> Registering the Bitbucket webhook (PR lifecycle events)"
existing_hook_id="$(curl -s -H "$AUTH_HEADER" "${BITBUCKET_API}/webhooks" \
  | json_get "next((str(h['id']) for h in data.get('values', []) if h.get('url') == '${WEBHOOK_URL}'), '')")"

hook_payload=$(python3 -c '
import json
print(json.dumps({
    "name": "DPC self-service portal",
    "url": "'"${WEBHOOK_URL}"'",
    "active": True,
    "events": [
        "pr:opened", "pr:modified", "pr:merged", "pr:declined", "pr:deleted",
        "pr:reviewer:approved", "pr:reviewer:needs_work",
    ],
}))
')

if [ -n "$existing_hook_id" ]; then
  curl -s -X PUT \
    -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    -d "$hook_payload" \
    "${BITBUCKET_API}/webhooks/${existing_hook_id}" >/dev/null
  echo "    updated existing webhook (id $existing_hook_id) to the current event set"
else
  create_status="$(curl -s -o /tmp/bb_hook_create.json -w '%{http_code}' -X POST \
    -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    -d "$hook_payload" \
    "${BITBUCKET_API}/webhooks")"
  if [ "$create_status" != "201" ]; then
    echo "    warning: webhook creation returned HTTP $create_status - check /tmp/bb_hook_create.json and add it manually via the repo's Settings -> Webhooks" >&2
  else
    echo "    created webhook"
  fi
fi

echo "==> Updating ../.env (VITE_API_BASE_URL, VITE_REPOSITORY_NAME)"
ENV_FILE="../.env"
if [ -f "$ENV_FILE" ]; then
  python3 - "$ENV_FILE" "${API_BASE_URL}/dpc" "$REPO_NAME" <<'PYEOF'
import re
import sys

path, api_base_url, repo_name = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    lines = f.readlines()

replacements = {"VITE_API_BASE_URL": api_base_url, "VITE_REPOSITORY_NAME": repo_name}
seen = set()
for i, line in enumerate(lines):
    for key, value in replacements.items():
        if line.startswith(f"{key}="):
            lines[i] = f"{key}={value}\n"
            seen.add(key)

for key, value in replacements.items():
    if key not in seen:
        lines.append(f"{key}={value}\n")

with open(path, "w") as f:
    f.writelines(lines)
PYEOF
  echo "    updated $ENV_FILE"
else
  echo "    ../.env doesn't exist yet - copy .env.example to .env first, then re-run this script" >&2
fi

cat <<SUMMARY

==================================================================
Org stack ready.

  API base URL      : ${API_BASE_URL}
  Bitbucket webhook  : ${WEBHOOK_URL}
  Failure DLQ (SQS)  : ${DLQ_URL}
  Retry sweep rule   : ${SWEEP_RULE}

Next step - from the repo root:
  npm install   (if you haven't already)
  npm run dev

Note: Azure AD SSO settings (VITE_CLIENT_ID etc.) and everything else
in .env besides the two keys above are left untouched by this script.

Note: comment-based decline/approve reasons (captured for the personal
GitHub stack via the "issue_comment" webhook event) are not yet built
for Bitbucket Server - out of scope for this pass.
==================================================================
SUMMARY
