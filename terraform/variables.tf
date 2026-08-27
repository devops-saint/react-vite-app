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

variable "pr_approver_usernames" {
  description = "Bitbucket usernames added as reviewers on every GitOps pull request. Leave empty to skip adding reviewers."
  type        = list(string)
  default     = []
}

variable "pr_approver_emails" {
  description = "Email addresses notified via SES when a GitOps pull request is opened. Not assumed to match pr_approver_usernames one-to-one."
  type        = list(string)
  default     = []
}

variable "notification_from_email" {
  description = "Verified SES sender identity (email or domain) used for approver and requester notification emails. Leave empty to disable both notifications."
  type        = string
  default     = ""
}
