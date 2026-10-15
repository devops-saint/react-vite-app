# Dynamic market list + admin market onboarding.
#
# GET  /dpc/markets - market codes read from the config repo (the folders
#                     under the repo path, on the dev branch) by the GitOps
#                     Lambda. Replaces the static VITE_AVAILABLE_MARKETS list.
# POST /dpc/markets - admin-only (checked in the Lambda): opens PRs adding a
#                     new market folder with values.yaml and
#                     values.dev/qa/prd.yaml to dev, qa and master.
#
# No new IAM or variables: the main Lambda already may invoke the GitOps
# Lambda, and the GitOps Lambda's existing git token already has write access.

resource "aws_apigatewayv2_route" "markets_list" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "GET /dpc/markets"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_route" "markets_onboard" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "POST /dpc/markets"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}
