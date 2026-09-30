variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "tags" {
  type        = map(string)
  description = "A map of tags to assign to the object"
  default     = {}
}

variable "lambda_filename" {}

variable "bitbucket_secret_name" {
  default = "bitbucket-token"
}

variable "bitbucket_secret_value" {
  sensitive = true
}

variable "newrelic_lambda_handler" {
  description = "New Relic Lambda handler"
  type        = string
}

variable "lambda_powertools_layer_arn" {
  description = "Lambda Powertools ARN"
  type        = string
}

variable "newrelic_layer_arn" {
  description = "New Relic Lambda layer ARN"
  type        = string
}

variable "lambda_python_runtime" {
  description = "Lambda python runtime version"
  type        = string
}

variable "product_code" {
  description = "Product Code"
}


variable "account_id" {
  description = "Account ID"
  type        = string
}

variable "newrelic_account_id" {
  description = "New Relic account ID"
  type        = string
}

variable "newrelic_license_key_infra" {
  description = "New Relic license key for infrastructure"
  type        = string
}


variable "pr_approver_emails" {
  description = "Email addresses notified via SES when a GitOps pull request is opened. Not assumed to match pr_approver_usernames one-to-one."
  type        = list(string)
  default     = []
}

variable "dolce_domain_name" {
  description = "Verified SES sender identity (email or domain) used for approver and requester notification emails."
  type        = string
  default     = ""
}

variable "bitbucket_url" {
  type    = string
  default = ""
}

variable "project_key" {
  type    = string
  default = ""
}

variable "repo_name" {
  type    = string
  default = "test-repo"
}

variable "repo_base_path" {
  type    = string
  default = "markets"
}

variable "enable_gitops_dlq" {
  type    = bool
  default = true
}

variable "market_lock_stale_seconds" {
  description = "How long (seconds) a per-market request lock (MARKETLOCK#<market>) can sit claimed before it's treated as abandoned and force-released for the next queued request. Default 24h; an admin can also force-release immediately via POST /dpc/requests/{id}/release-lock."
  type        = number
  default     = 86400
}

variable "azure_ad_group_fetch_lambda_name" {
  description = "Function name of the org's separate Azure AD group/RBAC-fetch Lambda (aws_lambda_function.azure_ad_group_fetch, provisioned outside this repo) - GET /access invokes it synchronously with {\"email\": ...} to resolve a user's real role and market/environment access. Must be a plain function name (aws_lambda_function.main's role is granted lambda:InvokeFunction scoped to that name in the same account/region - see aws_iam_policy.main_policy). Empty makes GET /access return 503 rather than fail silently."
  type        = string
  default     = "azure_ad_group_fetch"
}

# --- AWS-side access verification (idea #4) - see the AWS-SIDE ACCESS
# VERIFICATION comment block in handler.py. Backported from terraform/
# and terraform-personal/, since this stack shares the same handler.py
# but hadn't had this infra added yet.

variable "verification_sweep_schedule_expression" {
  description = "EventBridge schedule for the AWS-side access verification sweep (handle_validation_sweep), which confirms PENDING_AWS_VERIFICATION requests against the real agent-role IAM policy before marking them COMPLETED."
  type        = string
  default     = "rate(10 minutes)"
}

variable "aws_account_id_dev" {
  description = "AWS account id for the DEV agent role, used to build its cross-account IAM role ARN for AWS-side access verification. Mirrors VITE_AWS_ACCOUNT_ID_DEV on the frontend. Empty disables verification for DEV."
  type        = string
  default     = ""
}

variable "aws_account_id_qa" {
  description = "Same as aws_account_id_dev, for QA."
  type        = string
  default     = ""
}

variable "aws_account_id_prd" {
  description = "Same as aws_account_id_dev, for PRD."
  type        = string
  default     = ""
}

variable "aws_validation_role_arn_dev" {
  description = "ARN of the DEV account's dpc-portal-validator role (see the AWS-SIDE ACCESS VERIFICATION comment block in handler.py for the cross-account trust convention). Empty disables verification for DEV."
  type        = string
  default     = ""
}

variable "aws_validation_role_arn_qa" {
  description = "Same as aws_validation_role_arn_dev, for QA."
  type        = string
  default     = ""
}

variable "aws_validation_role_arn_prd" {
  description = "Same as aws_validation_role_arn_dev, for PRD."
  type        = string
  default     = ""
}
