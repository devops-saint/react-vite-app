variable "aws_region" {
  description = "AWS region for the API, Lambda, and DynamoDB table."
  type        = string
  default     = "eu-west-1"
}

variable "project_name" {
  description = "Prefix used for provisioned resource names."
  type        = string
  default     = "dpc-whitelisting-personal"
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
  default     = 14
}

variable "github_token_secret_name" {
  description = "Name of the existing Secrets Manager secret holding a GitHub PAT with Contents + Pull requests read/write access to the config repo. Must match the SecretId literal in lambda-gitops-personal/handler.py."
  type        = string
  default     = "github-token"
}

variable "pr_approver_usernames" {
  description = "GitHub usernames added as requested reviewers on every GitOps pull request. Leave empty to skip adding reviewers (fine for solo personal testing)."
  type        = list(string)
  default     = []
}

variable "pr_approver_emails" {
  description = "Email addresses notified via SES when a GitOps pull request is opened. Not assumed to match pr_approver_usernames one-to-one."
  type        = list(string)
  default     = []
}

variable "domain" {
  description = "Domain used to build the notification sender address, as noreply@<domain>. Must be a verified SES identity in this account/region. Leave empty (the default) to disable approver and requester notification emails entirely - every notify_* function no-ops cleanly when this is unset, which is the expected setup for personal testing with no verified SES domain."
  type        = string
  default     = ""
}

variable "github_owner" {
  description = "REQUIRED. GitHub username or org that owns the personal config repo, e.g. the account the repo lives under. The GitOps Lambda fails on every invocation until this is set."
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "REQUIRED. Name of the personal GitHub repo holding the per-market environment YAML files (e.g. aws-whitelist-config-personal). The GitOps Lambda fails on every invocation until this is set."
  type        = string
  default     = ""
}

variable "repo_base_path" {
  description = "REQUIRED. Path inside the repo under which each market's values.<env>.yaml files live. The GitOps Lambda fails on every invocation until this is set."
  type        = string
  default     = ""
}

variable "sweep_schedule_expression" {
  description = "EventBridge schedule for the automatic retry sweep (handle_sweep), which retries syncs that failed during a GitHub/Bitbucket outage. Keep in sync with SWEEP_STALE_MINUTES in lambda-gitops-personal/handler.py so stuck items get picked up roughly once per staleness window."
  type        = string
  default     = "rate(10 minutes)"
}

variable "enable_gitops_dlq" {
  description = "Whether to create the gitops_dlq SQS queue (and the Lambda on-failure destination pointing at it). Some AWS orgs deny sqs:CreateQueue via a Service Control Policy - set this to false in that case. handle_sweep's automatic retry sweep does not depend on this queue at all; only the last-resort manual-inspection visibility for an event that exhausted every retry (in-function and Lambda's own built-in async retries) is lost when this is false."
  type        = bool
  default     = true
}
