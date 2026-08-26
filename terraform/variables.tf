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
