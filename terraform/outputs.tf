output "api_base_url" {
  description = "Set this value as VITE_API_BASE_URL when building the portal."
  value       = aws_apigatewayv2_api.requests.api_endpoint
}

output "requests_table_name" {
  value = aws_dynamodb_table.requests.name
}

output "gitops_lambda_function_name" {
  description = "Name of the GitOps Lambda (already wired into GITOPS_LAMBDA_NAME on the request-api Lambda)."
  value       = aws_lambda_function.gitops.function_name
}
