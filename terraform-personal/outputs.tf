output "api_base_url" {
  description = "API Gateway base endpoint. The frontend's VITE_API_BASE_URL must be this value with /dpc appended (matching the route_keys below), e.g. https://xxxx.execute-api.eu-west-1.amazonaws.com/dpc."
  value       = aws_apigatewayv2_api.requests.api_endpoint
}

output "requests_table_name" {
  value = aws_dynamodb_table.requests.name
}

output "gitops_lambda_function_name" {
  description = "Name of the GitOps Lambda (already wired into GITOPS_LAMBDA_NAME on the request-api Lambda)."
  value       = aws_lambda_function.gitops.function_name
}

output "github_webhook_url" {
  description = "Point the personal config repo's webhook (Settings -> Webhooks -> Add webhook, content type application/json, events: Pull requests + Pull request reviews) at this URL."
  value       = "${aws_apigatewayv2_api.requests.api_endpoint}/dpc/github/webhook"
}

output "gitops_dlq_url" {
  description = "SQS queue that captures a GitOps Lambda invocation only if it fails all the way through _request_with_retry's retries AND Lambda's own built-in async retries - a rare last-resort signal that handle_sweep's automatic retries have also had trouble, worth checking manually. Reads 'disabled ...' when var.enable_gitops_dlq is false (e.g. an org SCP blocks sqs:CreateQueue) - handle_sweep's automatic retries are unaffected either way."
  value       = var.enable_gitops_dlq ? aws_sqs_queue.gitops_dlq[0].id : "disabled (enable_gitops_dlq = false)"
}

output "gitops_sweep_rule_name" {
  description = "EventBridge rule that periodically retries stuck syncs (SYNC_FAILED requests, FAILED/stuck promotion locks) - see handle_sweep."
  value       = aws_cloudwatch_event_rule.gitops_sweep.name
}
