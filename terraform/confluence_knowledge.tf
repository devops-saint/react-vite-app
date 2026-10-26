# Troubleshooting page: read Confluence pages with a service account.
#
# The portal's Troubleshooting page can only search the title/keywords/summary
# you put in VITE_TROUBLESHOOTING_CONFLUENCE_PAGES, because the browser can't
# open org-internal Confluence pages. With this file configured, the main
# Lambda (GET /dpc/troubleshoot/confluence) fetches the text of the pages listed in
# confluence_page_urls using a service account whose credentials are in
# Secrets Manager, so the search also matches what the pages actually say.
#
# Setup:
#   1. Create a Secrets Manager secret holding the service account, as JSON:
#        {"username": "svc-account", "api_token": "..."}   -> HTTP Basic
#        {"token": "..."}                                  -> Bearer (Data Center PAT)
#      (accepted key names: username|user|email and
#       api_token|apiToken|token|pat|password)
#   2. Give the account read access to the pages (view permission).
#   3. Set confluence_secret_id (secret name or full ARN) and
#      confluence_page_urls below, then apply.
#
# Nothing here is created or changed while confluence_secret_id is empty
# except the (harmless) route, which then answers {"configured": false}.
# The Lambda must be able to reach Confluence over the internet (it is not in a
# VPC); for an internal-only Confluence it would need VPC/network access.

variable "confluence_page_urls" {
  description = "https URLs of the Confluence pages the Troubleshooting page should read (Cloud /wiki/spaces/.../pages/<id>/..., Data Center /pages/viewpage.action?pageId=<id> or /display/<SPACE>/<Title>). At most 20 are used."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for url in var.confluence_page_urls : can(regex("^https://[^\\s,]+$", url))])
    error_message = "Every confluence_page_urls entry must be an https URL without spaces or commas."
  }
}

variable "confluence_secret_id" {
  description = "Name or full ARN of the Secrets Manager secret with the Confluence service account (see the comment at the top of confluence_knowledge.tf for the format). Empty disables the feature. If the secret uses a customer-managed KMS key, also allow the Lambda role kms:Decrypt on it."
  type        = string
  default     = ""
}

variable "confluence_api_base_url" {
  description = "Optional override of the Confluence REST API base, e.g. https://wiki.example.com/confluence/rest/api. Leave empty to derive it from each page URL. Must be on the same host as the page URLs."
  type        = string
  default     = ""
}

variable "confluence_cache_seconds" {
  description = "How long the Lambda keeps fetched Confluence text in memory before reading the pages again (minimum 60)."
  type        = number
  default     = 900
}

locals {
  confluence_secret_resource = (
    substr(var.confluence_secret_id, 0, 4) == "arn:"
    ? var.confluence_secret_id
    : "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.confluence_secret_id}-??????"
  )
}

# Read-only access to exactly that one secret.
resource "aws_iam_role_policy" "confluence_secret_read" {
  count = var.confluence_secret_id != "" ? 1 : 0

  name = "confluence-service-account-secret-read"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = local.confluence_secret_resource
    }]
  })
}

resource "aws_apigatewayv2_route" "troubleshoot_confluence" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "GET /dpc/troubleshoot/confluence"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}
