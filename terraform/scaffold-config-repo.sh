#!/usr/bin/env bash
# Scaffolds a Bitbucket Server "config repo" that mirrors the
# per-market/per-environment YAML layout the GitOps Lambda
# (lambda-gitops) branches/commits/PRs against - mirrors
# terraform-personal/scaffold-config-repo.sh exactly (git itself is
# host-agnostic; only the clone URL format differs from GitHub's).
#
# Layout created (matches REPO_BASE_PATH/{market}/values.{env}.yaml in
# lambda-gitops/handler.py's process_yaml_updates):
#   <repo_base_path>/<market>/values.dev.yaml
#   <repo_base_path>/<market>/values.qa.yaml
#   <repo_base_path>/<market>/values.prd.yaml
# identically on the dev, qa and master branches (linear history, so
# promotion PRs (dev->qa, qa->master) are pure merges with no
# conflicts).
#
# Market folder names are forced to lowercase - the frontend lowercases
# market_code before it ever reaches the Lambda, so the config repo's
# folders must be lowercase regardless of how you type MARKETS below.
#
# Usually not needed for the org stack: this repo typically already
# exists as a live Bitbucket repository with real history. Use this
# only when standing up a brand-new, empty config repo (a fresh
# environment, or a from-scratch test project).
#
# USAGE:
#   REPO_URL=https://x-token-auth:<bitbucket-http-access-token>@bitbucket.example.com/scm/DPC/aws-whitelist-config.git \
#   REPO_BASE_PATH=environments \
#   MARKETS="UK US" \
#   ./scaffold-config-repo.sh
#
#   REPO_URL      required. Git HTTP(S) clone URL of the EMPTY
#                 Bitbucket repo, of the form
#                 {BITBUCKET_URL}/scm/{PROJECT_KEY}/{repo-slug}.git.
#                 When authenticating with a Bitbucket Server HTTP
#                 access token, the username portion is ignored - any
#                 placeholder (e.g. x-token-auth) works, the token
#                 itself goes in the password slot.
#   REPO_BASE_PATH  optional. Must match terraform/terraform.tfvars
#                 repo_base_path. Defaults to "markets".
#   MARKETS       optional, space-separated market codes. Defaults to
#                 "UK US".

set -euo pipefail

: "${REPO_URL:?Set REPO_URL to the empty Bitbucket repo clone URL}"
REPO_BASE_PATH="${REPO_BASE_PATH:-markets}"
MARKETS="${MARKETS:-UK US}"

WORKDIR="$(mktemp -d)"
echo "Working in $WORKDIR"
cd "$WORKDIR"

git init -q -b master
git remote add origin "$REPO_URL"

for market in $MARKETS; do
  market_dir="$(printf '%s' "$market" | tr '[:upper:]' '[:lower:]')"
  mkdir -p "$REPO_BASE_PATH/$market_dir"
  for env in dev qa prd; do
    cat > "$REPO_BASE_PATH/$market_dir/values.$env.yaml" <<'YAML'
buckets: []
secrets: []
kmsKeys: []
functions: []
YAML
  done
done

git add -A
git -c user.name="Config Bootstrap" -c user.email="bootstrap@local" \
  commit -q -m "Initial config layout: ${MARKETS} x dev/qa/prd"

echo "Pushing master..."
git push -u origin master

echo "Creating and pushing dev (branched from master)..."
git checkout -q -b dev master
git push -u origin dev

echo "Creating and pushing qa (branched from master)..."
git checkout -q -b qa master
git push -u origin qa

echo
echo "Done. Branches dev, qa, master all exist with identical starting content."
echo "Set in terraform/terraform.tfvars:"
echo "  bitbucket_url  = \"<your Bitbucket Server base URL>\""
echo "  project_key    = \"<project key>\""
echo "  repo_name      = \"<repo slug>\""
echo "  repo_base_path = \"$REPO_BASE_PATH\""
echo
echo "Cleaning up $WORKDIR"
cd /
rm -rf "$WORKDIR"
