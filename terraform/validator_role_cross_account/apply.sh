#!/usr/bin/env bash
# Creates/updates the dpc-portal-validator role in ONE target account.
# Usage: TRUSTED_PRINCIPAL_ARN=<arn> ./apply.sh <env: dev|qa|prd> <account id> [plan|apply|destroy]
# Uses whatever AWS credentials are active in the shell (AWS_PROFILE etc.).
set -euo pipefail
cd "$(dirname "$0")"

env_name="${1:-}"; account_id="${2:-}"; action="${3:-apply}"
if [[ ! "$env_name" =~ ^(dev|qa|prd)$ || ! "$account_id" =~ ^[0-9]{12}$ ]]; then
  echo "usage: TRUSTED_PRINCIPAL_ARN=<arn> $0 <dev|qa|prd> <12-digit account id> [plan|apply|destroy]" >&2
  exit 2
fi
if [[ ! "$action" =~ ^(plan|apply|destroy)$ ]]; then
  echo "action must be plan, apply or destroy" >&2
  exit 2
fi
: "${TRUSTED_PRINCIPAL_ARN:?set TRUSTED_PRINCIPAL_ARN to the portal stack output validator_trusted_principal_arn}"

terraform init -input=false
terraform workspace select "$env_name" 2>/dev/null || terraform workspace new "$env_name"

extra=()
[[ "$action" != "plan" ]] && extra=(-auto-approve)
terraform "$action" -input=false "${extra[@]}" \
  -var "trusted_principal_arn=${TRUSTED_PRINCIPAL_ARN}" \
  -var "expected_account_id=${account_id}"

if [[ "$action" == "apply" ]]; then
  echo
  echo "Put these in the portal stack's tfvars:"
  echo "  aws_validation_role_arn_${env_name} = \"$(terraform output -raw validator_role_arn)\""
  echo "  aws_account_id_${env_name}          = \"$(terraform output -raw account_id)\""
fi
