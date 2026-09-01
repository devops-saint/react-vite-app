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

output "gitops_dlq_url" {
  description = "SQS queue that captures a GitOps Lambda invocation only if it fails all the way through _request_with_retry's retries AND Lambda's own built-in async retries - a rare last-resort signal that handle_sweep's automatic retries have also had trouble, worth checking manually. Reads 'disabled ...' when var.enable_gitops_dlq is false (e.g. an org SCP blocks sqs:CreateQueue) - handle_sweep's automatic retries are unaffected either way."
  value       = var.enable_gitops_dlq ? aws_sqs_queue.gitops_dlq[0].id : "disabled (enable_gitops_dlq = false)"
}

output "gitops_sweep_rule_name" {
  description = "EventBridge rule that periodically retries stuck syncs (SYNC_FAILED requests, FAILED/stuck promotion locks) - see handle_sweep."
  value       = aws_cloudwatch_event_rule.gitops_sweep.name
}
