# dpc-portal-validator role for a CROSS-ACCOUNT environment.
#
# Run this ONCE in each AWS account that hosts agent roles but is NOT the
# account the portal itself runs in (typically QA and PRD), using that
# account's own credentials. It is deliberately a separate Terraform root, not
# part of the portal stack, because the portal stack has no access into those
# accounts.
#
#   cd validator_role_cross_account
#   export AWS_PROFILE=<profile for the target account>   # or any other credentials
#   export TRUSTED_PRINCIPAL_ARN=<portal stack output validator_trusted_principal_arn>
#   ./apply.sh qa  <qa account id>
#   ./apply.sh prd <prd account id>
#
# apply.sh keeps one Terraform workspace (= one state) per environment, so QA and
# PRD never overwrite each other's state, and it refuses to run if the current
# credentials are not in the account id you gave (expected_account_id below).
# Plain terraform works too, but then select a separate workspace per account.
#
# DEV does not need this when the portal runs in the DEV account: use
# validator_same_account_environments = ["DEV"] in the portal stack instead.
#
# Then copy the printed validator_role_arn into the portal stack's tfvars as
# aws_validation_role_arn_qa / _prd (and set aws_account_id_<env> to the printed
# account_id), and apply the portal stack.
#
# The portal's main Lambda role must also be allowed to call sts:AssumeRole on
# arn:aws:iam::*:role/dpc-portal-validator; the portal stack already grants that.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "aws_region" {
  description = "Region used for the AWS provider (IAM itself is global)."
  type        = string
  default     = "eu-west-1"
}

variable "trusted_principal_arn" {
  description = "ARN of the portal's main Lambda execution role (output validator_trusted_principal_arn of the portal stack). Only this role may assume the validator role."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", var.trusted_principal_arn))
    error_message = "trusted_principal_arn must be an IAM role ARN such as arn:aws:iam::123456789012:role/name."
  }
}

variable "expected_account_id" {
  description = "Safety check: when set, Terraform refuses to run unless the credentials belong to this 12-digit AWS account id. Always set it (apply.sh does)."
  type        = string
  default     = ""

  validation {
    condition     = var.expected_account_id == "" || can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account id (or empty)."
  }
}

variable "agent_role_name_pattern" {
  description = "Name pattern of the agent roles the validator role may read (IAM wildcards allowed)."
  type        = string
  default     = "matillion-dpc-*-agent-*-irsa"
}

variable "tags" {
  description = "Tags for the role."
  type        = map(string)
  default     = {}
}

provider "aws" {
  region = var.aws_region

  # null = no restriction.
  allowed_account_ids = var.expected_account_id != "" ? [var.expected_account_id] : null
}

data "aws_caller_identity" "current" {}

locals {
  # Must stay "dpc-portal-validator" (the portal's sts:AssumeRole grant is
  # scoped to that name).
  role_name  = "dpc-portal-validator"
  account_id = data.aws_caller_identity.current.account_id
}

resource "aws_iam_role" "portal_validator" {
  name        = local.role_name
  description = "Read-only role the portal's main Lambda assumes to check which resources an agent role's IAM policy really allows."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = var.trusted_principal_arn }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { ManagedBy = "Terraform" })
}

resource "aws_iam_role_policy" "portal_validator" {
  name = "read-agent-role-policies"
  role = aws_iam_role.portal_validator.id

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
        Resource = "arn:aws:iam::${local.account_id}:role/${var.agent_role_name_pattern}"
      },
      {
        Sid    = "ReadAttachedManagedPolicies"
        Effect = "Allow"
        Action = [
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
        ]
        Resource = [
          "arn:aws:iam::${local.account_id}:policy/*",
          "arn:aws:iam::aws:policy/*",
        ]
      },
    ]
  })
}

output "validator_role_arn" {
  description = "Put this in the portal stack as aws_validation_role_arn_<env>."
  value       = aws_iam_role.portal_validator.arn
}

output "account_id" {
  description = "Put this in the portal stack as aws_account_id_<env>."
  value       = local.account_id
}
