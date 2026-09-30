variable "aws_region" {
  description = "AWS region for the API, Lambda, and DynamoDB table."
  type        = string
  default     = "eu-west-1"
}

variable "project_name" {
  description = "Prefix used for provisioned resource names."
  type        = string
  default     = "dpc-whitelisting"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "dev"
}

variable "cors_allow_origins" {
  description = "Browser origins allowed to call the API. Set this to the deployed portal URL outside development."
  type        = list(string)
  default     = ["http://localhost:3000", "http://localhost:5173"]
}

variable "cors_allow_headers" {
  description = "Request headers browsers may send to the API."
  type        = list(string)
  default = [
    "content-type",
    "authorization",
    "x-amz-date",
    "x-api-key",
    "x-amz-security-token",
  ]
}

variable "cors_allow_methods" {
  description = "HTTP methods browsers may use when calling the API."
  type        = list(string)
  default     = ["GET", "POST", "OPTIONS"]
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention period."
  type        = number
  default     = 30
}

variable "bitbucket_token_secret_name" {
  description = "Name of the existing Secrets Manager secret holding the Bitbucket access token. Must match the SecretId literal in lambda-gitops/handler.py."
  type        = string
  default     = "bitbucket-token"
}

variable "pr_approver_emails" {
  description = "Email addresses notified via SES when a GitOps pull request is opened. Approvers are notified by email only - they are not added as PR reviewers."
  type        = list(string)
  default     = []
}

variable "domain" {
  description = "Domain used to build the notification sender address, as noreply@<domain>. Must be a verified SES identity (the domain itself, or that exact address) in this account/region. Leave empty to disable approver and requester notification emails."
  type        = string
  default     = ""
}

variable "bitbucket_url" {
  description = "REQUIRED. Base URL of the Bitbucket Server instance, e.g. https://bitbucket.example.com. The GitOps Lambda fails on every invocation until this is set."
  type        = string
  default     = ""
}

variable "project_key" {
  description = "REQUIRED. Bitbucket project key that owns the config repo. The GitOps Lambda fails on every invocation until this is set."
  type        = string
  default     = ""
}

variable "market_lock_stale_seconds" {
  description = "How long (seconds) a per-market request lock (MARKETLOCK#<market>) can sit claimed before it's treated as abandoned and force-released for the next queued request. Default 24h; an admin can also force-release immediately via POST /dpc/requests/{id}/release-lock."
  type        = number
  default     = 86400
}

variable "repo_name" {
  description = "REQUIRED. Bitbucket repository slug holding the per-market environment YAML files. The GitOps Lambda fails on every invocation until this is set."
  type        = string
  default     = ""
}

variable "repo_base_path" {
  description = "REQUIRED. Path inside the repo under which each market's values.<env>.yaml files live. The GitOps Lambda fails on every invocation until this is set."
  type        = string
  default     = ""
}

variable "sweep_schedule_expression" {
  description = "EventBridge schedule for the automatic retry sweep (handle_sweep), which retries syncs that failed during a GitHub/Bitbucket outage. Keep in sync with SWEEP_STALE_MINUTES in lambda-gitops/handler.py so stuck items get picked up roughly once per staleness window."
  type        = string
  default     = "rate(10 minutes)"
}

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

variable "enable_gitops_dlq" {
  description = "Whether to create the gitops_dlq SQS queue (and the Lambda on-failure destination pointing at it). Some AWS orgs deny sqs:CreateQueue via a Service Control Policy - set this to false in that case. handle_sweep's automatic retry sweep does not depend on this queue at all; only the last-resort manual-inspection visibility for an event that exhausted every retry (in-function and Lambda's own built-in async retries) is lost when this is false."
  type        = bool
  default     = true
}


variable "azure_ad_group_fetch_lambda_name" {
  description = "Function name of the org's separate Azure AD group/RBAC-fetch Lambda (aws_lambda_function.azure_ad_group_fetch, provisioned outside this repo) - GET /dpc/access invokes it synchronously with {\"email\": ...} to resolve a user's real role and market/environment access. Must be a plain function name (this Lambda's own execution role is granted lambda:InvokeFunction scoped to that name in the same account/region - see aws_iam_role_policy.lambda). Empty makes GET /dpc/access return 503 rather than fail silently."
  type        = string
  default     = "azure_ad_group_fetch"
}
