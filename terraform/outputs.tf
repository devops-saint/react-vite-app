output "api_base_url" {
  description = "Set this value as VITE_API_BASE_URL when building the portal."
  value       = aws_apigatewayv2_api.requests.api_endpoint
}

output "requests_table_name" {
  value = aws_dynamodb_table.requests.name
}
