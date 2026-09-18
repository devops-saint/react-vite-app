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
