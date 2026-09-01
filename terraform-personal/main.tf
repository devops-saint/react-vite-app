locals {
  name = "${var.project_name}-${var.environment}"

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "Terraform"
  }

  # abspath() renders Windows-style paths ("C:\...") when the terraform
  # binary running this apply is a Windows build - used below so the
  # gitops layer's local-exec provisioner runs a command the host shell
  # actually understands, instead of assuming a Unix shell everywhere.
  is_windows = substr(abspath(path.module), 1, 1) == ":"
}

data "aws_caller_identity" "current" {}

# Looked up, not managed here - the GitHub token is created out of band.
# Its name must match the SecretId literal in lambda-gitops-personal/handler.py.
data "aws_secretsmanager_secret" "github_token" {
  name = var.github_token_secret_name
}

resource "aws_dynamodb_table" "requests" {
  name         = "${local.name}-requests"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "request_id"

  attribute {
    name = "request_id"
    type = "S"
  }

  attribute {
    name = "submitted_by_id"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  global_secondary_index {
    name            = "submitted-by-created-at"
    hash_key        = "submitted_by_id"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = local.tags
}

data "archive_file" "request_api" {
  type        = "zip"
  source_dir  = "${path.module}/lambda-personal"
  output_path = "${path.module}/.build/request_api.zip"
  excludes    = ["__pycache__"]
}

resource "aws_iam_role" "lambda" {
  name = "${local.name}-request-api-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "lambda" {
  name = "${local.name}-request-api"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        # DeleteItem is required to release a resolved promotion's
        # LOCK#<branch> item once its PR merges/is declined/is closed.
        Action = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = [
          aws_dynamodb_table.requests.arn,
          "${aws_dynamodb_table.requests.arn}/index/submitted-by-created-at",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.gitops.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:*"
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}-request-api"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_lambda_function" "request_api" {
  function_name    = "${local.name}-request-api"
  role             = aws_iam_role.lambda.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  filename         = data.archive_file.request_api.output_path
  source_code_hash = data.archive_file.request_api.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      DYNAMODB_TABLE     = aws_dynamodb_table.requests.name
      CORS_ALLOW_ORIGINS = jsonencode(var.cors_allow_origins)
      GITOPS_LAMBDA_NAME = aws_lambda_function.gitops.function_name
      # No verified SES domain for personal testing - leave var.domain
      # unset. Every notify_* function no-ops on its own; nothing else
      # needs to change.
      DOMAIN = var.domain
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
  tags       = local.tags
}

# =====================================================
# GitOps Lambda (GitHub instead of Bitbucket Server)
# =====================================================

resource "null_resource" "gitops_dependencies" {
  triggers = {
    requirements_hash = filemd5("${path.module}/lambda-gitops-personal/requirements.txt")
  }

  provisioner "local-exec" {
    # local-exec runs under cmd.exe by default on Windows, which doesn't
    # understand rm/mkdir -p/&&-chaining - hence the OS-conditional
    # command and interpreter below (see local.is_windows above). Requires
    # pip3 (and, on Windows, PowerShell - present by default on all
    # supported Windows versions) on whatever machine runs `terraform
    # apply`; both packages themselves are pure Python, so only the
    # packaging step, not the packages, needs an OS-specific command.
    interpreter = local.is_windows ? ["PowerShell", "-Command"] : ["/bin/sh", "-c"]
    command = local.is_windows ? "Remove-Item -Recurse -Force '${path.module}\\.build\\gitops-layer' -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force -Path '${path.module}\\.build\\gitops-layer\\python' | Out-Null; pip3 install --upgrade -r '${path.module}\\lambda-gitops-personal\\requirements.txt' -t '${path.module}\\.build\\gitops-layer\\python'" : "rm -rf ${path.module}/.build/gitops-layer && mkdir -p ${path.module}/.build/gitops-layer/python && pip3 install --upgrade -r ${path.module}/lambda-gitops-personal/requirements.txt -t ${path.module}/.build/gitops-layer/python"
  }
}

data "archive_file" "gitops_layer" {
  type        = "zip"
  source_dir  = "${path.module}/.build/gitops-layer"
  output_path = "${path.module}/.build/gitops-layer.zip"
  depends_on  = [null_resource.gitops_dependencies]
}

resource "aws_lambda_layer_version" "gitops_dependencies" {
  layer_name          = "${local.name}-gitops-dependencies"
  filename            = data.archive_file.gitops_layer.output_path
  source_code_hash    = data.archive_file.gitops_layer.output_base64sha256
  compatible_runtimes = ["python3.12"]
}

data "archive_file" "gitops" {
  type        = "zip"
  source_dir  = "${path.module}/lambda-gitops-personal"
  output_path = "${path.module}/.build/gitops.zip"
  excludes    = ["requirements.txt", "__pycache__", "_to_delete"]
}

resource "aws_iam_role" "gitops_lambda" {
  name = "${local.name}-gitops-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "gitops_lambda" {
  name = "${local.name}-gitops"
  role = aws_iam_role.gitops_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    # The sqs:SendMessage statement is appended only when the DLQ itself
    # is enabled (var.enable_gitops_dlq) - some AWS orgs block SQS queue
    # creation via a Service Control Policy, and this keeps the rest of
    # the stack deployable when that's the case. See aws_sqs_queue.gitops_dlq.
    Statement = concat([
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = data.aws_secretsmanager_secret.github_token.arn
      },
      {
        Effect = "Allow"
        # PR#<id> lookup items and LOCK#<branch> claim items, stored in
        # the same table as request items under prefixed keys. Scan is
        # for handle_sweep, which finds stuck SYNC_FAILED requests and
        # FAILED/stuck-CLAIMING locks to retry.
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Scan"]
        Resource = aws_dynamodb_table.requests.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:*:*"
      }
    ], var.enable_gitops_dlq ? [{
      Effect = "Allow"
      # Lambda uses the function's own execution role to write to an
      # async invoke's on-failure destination.
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.gitops_dlq[0].arn
    }] : [])
  })
}

resource "aws_cloudwatch_log_group" "gitops_lambda" {
  name              = "/aws/lambda/${local.name}-gitops"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_lambda_function" "gitops" {
  function_name    = "${local.name}-gitops"
  role             = aws_iam_role.gitops_lambda.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  filename         = data.archive_file.gitops.output_path
  source_code_hash = data.archive_file.gitops.output_base64sha256
  layers           = [aws_lambda_layer_version.gitops_dependencies.arn]
  # 240s gives headroom for _request_with_retry's worst case (3 attempts
  # at the longest per-call timeout, 60s, plus backoff) on a single
  # GitHub call - execution stops at the first call that exhausts
  # retries, so this bounds one invocation, not the sum of every call.
  timeout          = 240
  memory_size      = 256

  environment {
    variables = {
      DYNAMODB_TABLE        = aws_dynamodb_table.requests.name
      GITHUB_OWNER          = var.github_owner
      GITHUB_REPO           = var.github_repo
      REPO_BASE_PATH        = var.repo_base_path
      PR_APPROVER_USERNAMES = join(",", var.pr_approver_usernames)
      PR_APPROVER_EMAILS    = join(",", var.pr_approver_emails)
      DOMAIN                = var.domain
    }
  }

  depends_on = [aws_cloudwatch_log_group.gitops_lambda]
  tags       = local.tags
}

# =====================================================
# GitOps Lambda resilience: on-failure destination + retry sweep
# =====================================================
# If a GitHub/Bitbucket outage outlasts _request_with_retry's in-function
# retries AND Lambda's own built-in async retries (2 more, over several
# minutes), the failed event lands here instead of being silently
# dropped - useful for manual inspection. handle_sweep (triggered on the
# schedule below) is the actual automatic-recovery path; this queue is
# the visibility/last-resort backstop.
resource "aws_sqs_queue" "gitops_dlq" {
  # Some AWS orgs deny sqs:CreateQueue via a Service Control Policy -
  # var.enable_gitops_dlq lets that org still deploy everything else
  # (including handle_sweep's automatic retries, which don't need this
  # queue at all - it's only the last-resort visibility backstop).
  count                     = var.enable_gitops_dlq ? 1 : 0
  name                      = "${local.name}-gitops-dlq"
  message_retention_seconds = 1209600 # 14 days
  tags                      = local.tags
}

resource "aws_lambda_function_event_invoke_config" "gitops" {
  count         = var.enable_gitops_dlq ? 1 : 0
  function_name = aws_lambda_function.gitops.function_name

  destination_config {
    on_failure {
      destination = aws_sqs_queue.gitops_dlq[0].arn
    }
  }
}

# Periodically retries anything handle_create_pr/handle_promote left in
# SYNC_FAILED (initial PR never opened) or with a promotion LOCK stuck
# FAILED/CLAIMING (promotion PR never opened) - see handle_sweep in
# lambda-gitops-personal/handler.py for the actual retry logic.
resource "aws_cloudwatch_event_rule" "gitops_sweep" {
  name                = "${local.name}-gitops-sweep"
  description         = "Retries GitHub syncs that failed during an outage/maintenance window"
  schedule_expression = var.sweep_schedule_expression
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "gitops_sweep" {
  rule = aws_cloudwatch_event_rule.gitops_sweep.name
  arn  = aws_lambda_function.gitops.arn
  input = jsonencode({
    action = "SWEEP"
  })
}

resource "aws_lambda_permission" "eventbridge_sweep" {
  statement_id  = "AllowEventBridgeSweepInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.gitops.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.gitops_sweep.arn
}

resource "aws_apigatewayv2_api" "requests" {
  name          = "${local.name}-requests"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.cors_allow_origins
    allow_methods = var.cors_allow_methods
    allow_headers = var.cors_allow_headers
    max_age       = 3600
  }

  tags = local.tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.requests.id
  name        = "$default"
  auto_deploy = true

  tags = local.tags
}

resource "aws_apigatewayv2_integration" "request_api" {
  api_id                 = aws_apigatewayv2_api.requests.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.request_api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "create_request" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "POST /dpc/request"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_route" "list_requests" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "GET /dpc/listrequests"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_route" "request_details" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "GET /dpc/requests/{request_id}"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

# GitHub webhooks are configured to POST here (Settings -> Webhooks on the
# personal config repo). Note the path differs from org's
# /dpc/bitbucket/webhook - this is /dpc/github/webhook.
resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "POST /dpc/github/webhook"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.request_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.requests.execution_arn}/*/*"
}
