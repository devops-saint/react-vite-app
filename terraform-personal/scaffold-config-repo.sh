#!/usr/bin/env bash
# Scaffolds a personal GitHub "config repo" that mirrors the org's
# per-market/per-environment YAML layout, so the personal GitOps Lambda
# (lambda-gitops-personal) has something real to branch/commit/PR against.
#
# Layout created (matches REPO_BASE_PATH/{market}/values.{env}.yaml in
# terraform/lambda-gitops/handler.py's process_yaml_updates):
#   <repo_base_path>/<market>/values.dev.yaml
#   <repo_base_path>/<market>/values.qa.yaml
#   <repo_base_path>/<market>/values.prd.yaml
# identically on the dev, qa and master branches (linear history, so
# promotion PRs (dev->qa, qa->master) are pure merges with no conflicts).
#
# Market folder names are forced to lowercase. The frontend lowercases
# market_code before it ever reaches the Lambda
# (src/api/services/apiGatewayService.ts: market_code: formData.marketCode.toLowerCase()),
# so the config repo's folders MUST be lowercase too, regardless of the
# case you type into MARKETS below or how VITE_AVAILABLE_MARKETS is cased.
#
# PREREQUISITE (manual, one-time, via github.com UI - no `gh` CLI needed):
#   1. Go to https://github.com/new
#   2. Repository name: aws-whitelist-config-personal (or your choice)
#   3. Visibility: private (recommended) or public
#   4. Do NOT initialize with a README/.gitignore/license - leave it
#      completely empty. This script creates the initial commit itself.
#
# USAGE:
#   REPO_URL=git@github.com:<you>/aws-whitelist-config-personal.git \
#   REPO_BASE_PATH=markets \
#   MARKETS="UK US" \
#   ./scaffold-config-repo.sh
#
#   REPO_URL      required. SSH or HTTPS clone URL of the empty repo you
#                 just created.
#   REPO_BASE_PATH  optional. Must match terraform-personal/terraform.tfvars
#                 repo_base_path. Defaults to "markets".
#   MARKETS       optional, space-separated market codes. Defaults to
#                 "UK US" - a couple of samples from VITE_AVAILABLE_MARKETS
#                 (add more later by repeating the same file pattern on
#                 all three branches).

set -euo pipefail

: "${REPO_URL:?Set REPO_URL to the empty GitHub repo clone URL}"
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
git -c user.name="Personal Config Bootstrap" -c user.email="bootstrap@local" \
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
echo "Set in terraform-personal/terraform.tfvars:"
echo "  github_owner   = \"<your-github-username-or-org>\""
echo "  github_repo    = \"<repo name, e.g. aws-whitelist-config-personal>\""
echo "  repo_base_path = \"$REPO_BASE_PATH\""
echo
echo "Cleaning up $WORKDIR"
cd /
rm -rf "$WORKDIR"
