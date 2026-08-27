locals {
  name = "${var.project_name}-${var.environment}"

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

data "aws_caller_identity" "current" {}

# Looked up, not managed here - the Bitbucket token is created out of band.
# Its name must match the SecretId literal in lambda-gitops/handler.py.
data "aws_secretsmanager_secret" "bitbucket_token" {
  name = var.bitbucket_token_secret_name
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
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/.build/request_api.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${local.name}-request-api-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action = "sts:AssumeRole"
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
        # UpdateItem is required by the /webhook handler, which advances
        # request status as the linked Bitbucket PR progresses.
        Action = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"]
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
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
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
      REQUESTS_TABLE          = aws_dynamodb_table.requests.name
      CORS_ALLOW_ORIGINS      = jsonencode(var.cors_allow_origins)
      GITOPS_LAMBDA_NAME      = aws_lambda_function.gitops.function_name
      NOTIFICATION_FROM_EMAIL = var.notification_from_email
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
  tags       = local.tags
}

# =====================================================
# GitOps Lambda (branch/commit/PR + reviewer + approver notification)
# =====================================================

# requests + ruamel.yaml aren't in the Lambda Python runtime, so they're
# packaged as a layer. Requires pip3 on whatever machine runs `terraform
# apply` - both packages are pure Python, so this is platform-independent.
resource "null_resource" "gitops_dependencies" {
  triggers = {
    requirements_hash = filemd5("${path.module}/lambda-gitops/requirements.txt")
  }

  provisioner "local-exec" {
    command = "rm -rf ${path.module}/.build/gitops-layer && mkdir -p ${path.module}/.build/gitops-layer/python && pip3 install --upgrade -r ${path.module}/lambda-gitops/requirements.txt -t ${path.module}/.build/gitops-layer/python"
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
  source_dir  = "${path.module}/lambda-gitops"
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
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = data.aws_secretsmanager_secret.bitbucket_token.arn
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
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      PR_APPROVER_USERNAMES   = join(",", var.pr_approver_usernames)
      PR_APPROVER_EMAILS      = join(",", var.pr_approver_emails)
      NOTIFICATION_FROM_EMAIL = var.notification_from_email
    }
  }

  depends_on = [aws_cloudwatch_log_group.gitops_lambda]
  tags       = local.tags
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

# A $default stage is served at the API base URL, with no /stage-name segment.
# auto_deploy ensures route and CORS updates are released with terraform apply.
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
  route_key = "POST /request"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_route" "list_requests" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "GET /listrequests"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_route" "request_details" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "GET /requests/{requestId}"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "POST /webhook"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.request_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.requests.execution_arn}/*/*"
}
