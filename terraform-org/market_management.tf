# Dynamic market list + admin market onboarding.
#
# GET  /markets - market codes read from the config repo (the folders under
#                 the repo path, on the dev branch) by the GitOps Lambda.
#                 Replaces the static VITE_AVAILABLE_MARKETS list.
# POST /markets - admin-only (checked in the Lambda): opens PRs adding a new
#                 market folder with values.yaml and values.dev/qa/prd.yaml
#                 to dev, qa and master.
#
# Route keys have no /dpc prefix here because this stack uses the named
# "dpc" stage, which adds it. No new IAM or variables: the main Lambda
# already may invoke the GitOps Lambda, and its git token already has write
# access. This stack deploys the shared handler.py, so the Lambda code
# needs rebuilding into var.lambda_filename for these routes to work.

resource "aws_apigatewayv2_route" "markets_list" {
  api_id    = aws_apigatewayv2_api.portal.id
  route_key = "GET /markets"
  target    = "integrations/${aws_apigatewayv2_integration.main.id}"
}

resource "aws_apigatewayv2_route" "markets_onboard" {
  api_id    = aws_apigatewayv2_api.portal.id
  route_key = "POST /markets"
  target    = "integrations/${aws_apigatewayv2_integration.main.id}"
}
