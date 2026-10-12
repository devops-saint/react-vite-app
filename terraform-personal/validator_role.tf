# AWS-side access verification (idea #4): the "dpc-portal-validator" role.
#
# The main Lambda's verification sweep (handle_validation_sweep in handler.py)
# assumes this role through sts:AssumeRole and uses it to READ the IAM policy of
# the matillion-dpc-<env>-agent-<market>-irsa role in the target account, to
# confirm a requested resource is really whitelisted (or really removed, for a
# de-whitelist) before a request is marked COMPLETED.
#
# SAME ACCOUNT  - set validator_same_account_environments (below). This file then
#                 creates the role in THIS stack's account, trusts this stack's
#                 Lambda role, and points AWS_VALIDATION_ROLE_ARN_<ENV> at it
#                 automatically for those environments.
# CROSS ACCOUNT - the role has to exist in each other account. Apply
#                 ./validator_role_cross_account in that account (see the README
#                 comment at the top of that file), then put the ARN it prints
#                 into aws_validation_role_arn_dev / _qa / _prd. An explicit
#                 aws_validation_role_arn_<env> always wins over the same-account
#                 role, so both can be mixed (e.g. DEV same account, QA/PRD
#                 cross account).
#
# Nothing is created, and nothing changes, while validator_same_account_environments
# is empty (the default).

variable "validator_same_account_environments" {
  description = "Environments (any of DEV, QA, PRD) whose agent roles live in THIS stack's own AWS account. If non-empty, the dpc-portal-validator role is created in this account and used for those environments unless an explicit aws_validation_role_arn_<env> is set. The matching aws_account_id_<env> must be this account's id. Leave empty if every environment is in another account (use ./validator_role_cross_account there instead)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for env in var.validator_same_account_environments : contains(["DEV", "QA", "PRD"], env)])
    error_message = "validator_same_account_environments may only contain DEV, QA and PRD (upper case)."
  }
}

variable "validator_agent_role_name_pattern" {
  description = "Name pattern of the agent roles the validator role may read (IAM wildcards allowed). Must cover the names the portal builds: matillion-dpc-<env>-agent-<market>-irsa."
  type        = string
  default     = "matillion-dpc-*-agent-*-irsa"
}

locals {
  # Must stay "dpc-portal-validator": the main Lambda's sts:AssumeRole grant is
  # scoped to arn:aws:iam::*:role/dpc-portal-validator.
  validator_role_name  = "dpc-portal-validator"
  validator_account_id = data.aws_caller_identity.current.account_id
  validator_enabled    = length(var.validator_same_account_environments) > 0

  validator_same_account_role_arn = try(aws_iam_role.portal_validator[0].arn, "")

  # Role ARN handed to the Lambda per environment: explicit ARN (cross account)
  # first, otherwise this account's validator role if the env is listed above.
  validation_role_arn_dev = var.aws_validation_role_arn_dev != "" ? var.aws_validation_role_arn_dev : (contains(var.validator_same_account_environments, "DEV") ? local.validator_same_account_role_arn : "")
  validation_role_arn_qa  = var.aws_validation_role_arn_qa != "" ? var.aws_validation_role_arn_qa : (contains(var.validator_same_account_environments, "QA") ? local.validator_same_account_role_arn : "")
  validation_role_arn_prd = var.aws_validation_role_arn_prd != "" ? var.aws_validation_role_arn_prd : (contains(var.validator_same_account_environments, "PRD") ? local.validator_same_account_role_arn : "")
}

resource "aws_iam_role" "portal_validator" {
  count = local.validator_enabled ? 1 : 0

  name        = local.validator_role_name
  description = "Read-only role the portal's main Lambda assumes to check which resources an agent role's IAM policy really allows."

  # Only the portal's main Lambda execution role may assume it.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = aws_iam_role.lambda.arn }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags

  lifecycle {
    precondition {
      condition = alltrue([
        for env in var.validator_same_account_environments :
        lookup({ DEV = var.aws_account_id_dev, QA = var.aws_account_id_qa, PRD = var.aws_account_id_prd }, env, "") == local.validator_account_id
      ])
      error_message = "Every environment in validator_same_account_environments needs its aws_account_id_<env> set to this stack's own account id; otherwise the Lambda would look for the agent role in a different account than the one this validator role can read."
    }
  }
}

# Read-only. What the handler calls today: ListRolePolicies + GetRolePolicy (inline
# policies) and ListAttachedRolePolicies + GetPolicy + GetPolicyVersion (managed
# policies). GetRole is not called today; it is kept for diagnostics.
resource "aws_iam_role_policy" "portal_validator" {
  count = local.validator_enabled ? 1 : 0

  name = "read-agent-role-policies"
  role = aws_iam_role.portal_validator[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadAgentRoles"
        Effect = "Allow"
        Action = [
          "iam:GetRole",
          "iam:ListRolePolicies",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
        ]
        Resource = "arn:aws:iam::${local.validator_account_id}:role/${var.validator_agent_role_name_pattern}"
      },
      {
        Sid    = "ReadAttachedManagedPolicies"
        Effect = "Allow"
        Action = [
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
        ]
        Resource = [
          "arn:aws:iam::${local.validator_account_id}:policy/*",
          "arn:aws:iam::aws:policy/*",
        ]
      },
    ]
  })
}

output "validator_role_arn" {
  description = "ARN of the same-account dpc-portal-validator role (empty when validator_same_account_environments is empty)."
  value       = local.validator_same_account_role_arn
}

output "validator_trusted_principal_arn" {
  description = "Value for trusted_principal_arn when applying ./validator_role_cross_account in another account: this stack's main Lambda role."
  value       = aws_iam_role.lambda.arn
}
