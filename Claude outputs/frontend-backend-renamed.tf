### Frontend

resource "aws_s3_bucket" "frontend" {
  bucket = "${var.project_name}-${var.environment}-frontend"
  tags = merge(var.tags,
    {
      Backup_Plan = "none"
  })
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project_name}-${var.environment}-oac"
  description                       = "S3 Origin Access Control"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-origin"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = [
      "GET",
      "HEAD",
      "OPTIONS"
    ]

    cached_methods = [
      "GET",
      "HEAD"
    ]

    compress = true

    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = var.tags
}

data "aws_iam_policy_document" "frontend" {
  statement {
    sid = "AllowCloudFrontServicePrincipalReadOnly"

    actions = [
      "s3:GetObject"
    ]

    resources = [
      "${aws_s3_bucket.frontend.arn}/*"
    ]

    principals {
      type = "Service"

      identifiers = [
        "cloudfront.amazonaws.com"
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"

      values = [
        aws_cloudfront_distribution.frontend.arn
      ]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend.json
}



### Backend

resource "aws_dynamodb_table" "requests" {

  name         = "${var.project_name}-requests"
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

  tags = var.tags
}

resource "aws_secretsmanager_secret" "bitbucket_token" {
  name = var.bitbucket_secret_name
}

resource "aws_secretsmanager_secret_version" "bitbucket_token" {
  secret_id     = aws_secretsmanager_secret.bitbucket_token.id
  secret_string = var.bitbucket_secret_value
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type = "Service"
      identifiers = [
        "lambda.amazonaws.com"
      ]
    }
  }
}


resource "aws_iam_role" "lambda" {
  name               = "${var.project_name}-main-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

resource "aws_iam_role" "gitops_lambda" {
  name               = "${var.project_name}-gitops-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = var.tags
}

resource "aws_iam_policy" "lambda" {
  name = "${var.project_name}-main-policy"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ],
        Resource = [
          aws_dynamodb_table.requests.arn,
          "${aws_dynamodb_table.requests.arn}/index/submitted-by-created-at",
        ]
      },

      {
        Effect = "Allow",
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail",
          "ses:SendTemplatedEmail"
        ],
        Resource = "*"
      },

      {
        Effect = "Allow",
        Action = [
          "lambda:InvokeFunction"
        ],
        Resource = "*"
      }
    ]
  })
}


resource "aws_iam_policy" "gitops_lambda" {
  name = "${var.project_name}-gitops-policy"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "secretsmanager:GetSecretValue"
        ],
        Resource = aws_secretsmanager_secret.bitbucket_token.arn
      },

      {
        Effect = "Allow",
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail",
          "ses:SendTemplatedEmail"
        ],
        Resource = "*"
      },

      {
        Effect = "Allow",
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Scan"
        ],
        Resource = [
          aws_dynamodb_table.requests.arn,
          "${aws_dynamodb_table.requests.arn}/index/submitted-by-created-at",
        ]
      }
    ]
  })
}


resource "aws_iam_role_policy_attachment" "lambda" {
  role       = aws_iam_role.lambda.name
  policy_arn = aws_iam_policy.lambda.arn
}

resource "aws_iam_role_policy_attachment" "gitops_lambda" {
  role       = aws_iam_role.gitops_lambda.name
  policy_arn = aws_iam_policy.gitops_lambda.arn
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "gitops_lambda_basic_execution" {
  role       = aws_iam_role.gitops_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}


resource "aws_lambda_function" "request_api" {
  function_name = "${var.project_name}-main"
  filename      = var.lambda_filename
  role          = aws_iam_role.lambda.arn
  runtime       = "python${var.lambda_python_runtime}"
  handler       = var.newrelic_lambda_handler
  memory_size   = 1024 # MB
  timeout       = 900  # seconds
  layers = [
    var.lambda_powertools_layer_arn,
    var.newrelic_layer_arn
  ]

  environment {

    variables = {

      DYNAMODB_TABLE                          = aws_dynamodb_table.requests.name
      GITOPS_LAMBDA_NAME                      = "${var.project_name}-gitops"
      DOMAIN                                  = var.dolce_domain_name
      ENVIRONMENT                             = var.environment
      PRODUCT_CODE                            = var.product_code
      AWS_ACCOUNT_NUMBER                      = var.account_id
      CORS_ALLOW_ORIGINS                      = jsonencode(["https://${aws_cloudfront_distribution.frontend.domain_name}"])
      NEW_RELIC_ACCOUNT_ID                    = var.newrelic_account_id
      NEW_RELIC_EXTENSION_SEND_EXTENSION_LOGS = "true"
      NEW_RELIC_EXTENSION_SEND_FUNCTION_LOGS  = "true"
      NEW_RELIC_LAMBDA_HANDLER                = "lambda_function.lambda_handler"
      NEW_RELIC_LICENSE_KEY                   = var.newrelic_license_key_infra
    }
  }

  tags = merge(
    { "GIT_COMMIT" = "" },
    var.tags,
    { "lambdaVersion" = "" }
  )
}


resource "aws_lambda_function" "gitops" {
  function_name = "${var.project_name}-gitops"
  filename      = var.lambda_filename
  role          = aws_iam_role.gitops_lambda.arn
  runtime       = "python${var.lambda_python_runtime}"
  handler       = var.newrelic_lambda_handler
  memory_size   = 1024 # MB
  timeout       = 900  # seconds
  layers = [
    var.lambda_powertools_layer_arn,
    var.newrelic_layer_arn
  ]

  environment {

    variables = {
      DYNAMODB_TABLE                          = aws_dynamodb_table.requests.name
      DOMAIN                                  = var.dolce_domain_name
      PR_APPROVER_EMAILS                      = join(",", var.pr_approver_emails)
      SECRET_NAME                             = aws_secretsmanager_secret.bitbucket_token.name
      ENVIRONMENT                             = var.environment
      PRODUCT_CODE                            = var.product_code
      AWS_ACCOUNT_NUMBER                      = var.account_id
      BITBUCKET_URL                           = var.bitbucket_url
      PROJECT_KEY                             = var.project_key
      REPO_NAME                               = var.repo_name
      REPO_BASE_PATH                          = var.repo_base_path
      NEW_RELIC_ACCOUNT_ID                    = var.newrelic_account_id
      NEW_RELIC_EXTENSION_SEND_EXTENSION_LOGS = "true"
      NEW_RELIC_EXTENSION_SEND_FUNCTION_LOGS  = "true"
      NEW_RELIC_LAMBDA_HANDLER                = "lambda_function.lambda_handler"
      NEW_RELIC_LICENSE_KEY                   = var.newrelic_license_key_infra
    }
  }

  tags = merge(
    { "GIT_COMMIT" = "" },
    var.tags,
    { "lambdaVersion" = "" }
  )

}


resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${aws_lambda_function.request_api.function_name}"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "gitops_lambda" {
  name              = "/aws/lambda/${aws_lambda_function.gitops.function_name}"
  retention_in_days = 30
  tags              = var.tags
}


resource "aws_apigatewayv2_api" "requests" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [
      "https://${aws_cloudfront_distribution.frontend.domain_name}"
    ]

    allow_methods = [
      "GET",
      "POST",
      "OPTIONS"
    ]

    allow_headers = [
      "Content-Type",
      "Authorization",
      "X-Amz-Date",
      "X-Api-Key",
      "X-Amz-Security-Token"
    ]

    expose_headers = [
      "Content-Type"
    ]

    allow_credentials = true
    max_age           = 3600
  }

  tags = var.tags
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
  route_key = "GET /requests/{request_id}"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}


resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "POST /bitbucket/webhook"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_route" "release_market_lock" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "POST /requests/{request_id}/release-lock"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_route" "retry_promotion" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "POST /requests/{request_id}/retry-promotion"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_route" "get_whitelist" {
  api_id    = aws_apigatewayv2_api.requests.id
  route_key = "GET /whitelist/{market_code}/{environment}"
  target    = "integrations/${aws_apigatewayv2_integration.request_api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.requests.id
  name        = "dpc"
  auto_deploy = true
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.request_api.function_name
  principal     = "apigateway.amazonaws.com"
  # Without source_arn this grants ANY API Gateway HTTP API in this AWS
  # account (not just aws_apigatewayv2_api.requests) permission to invoke this
  # function - scoping it down to this specific API/stage/route.
  source_arn = "${aws_apigatewayv2_api.requests.execution_arn}/*/*"
}

# --- Resilience: DLQ + retry sweep for the gitops Lambda ---

resource "aws_sqs_queue" "gitops_dlq" {
  count                     = var.enable_gitops_dlq ? 1 : 0
  name                      = "${var.project_name}-gitops-dlq"
  message_retention_seconds = 1209600 # 14 days
  tags                      = var.tags
}

resource "aws_lambda_function_event_invoke_config" "gitops" {
  count                        = var.enable_gitops_dlq ? 1 : 0
  function_name                = aws_lambda_function.gitops.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 3600

  destination_config {
    on_failure {
      destination = aws_sqs_queue.gitops_dlq[0].arn
    }
  }
}

resource "aws_iam_role_policy" "gitops_lambda_dlq" {
  count = var.enable_gitops_dlq ? 1 : 0
  name  = "${var.project_name}-gitops-dlq-policy"
  role  = aws_iam_role.gitops_lambda.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect   = "Allow",
        Action   = ["sqs:SendMessage"],
        Resource = aws_sqs_queue.gitops_dlq[0].arn
      }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "gitops_sweep" {
  name                = "${var.project_name}-gitops-sweep"
  description         = "Periodically retries SYNC_FAILED requests and stuck/orphaned promotion locks."
  schedule_expression = "rate(10 minutes)"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "gitops_sweep" {
  rule      = aws_cloudwatch_event_rule.gitops_sweep.name
  target_id = "gitops-lambda"
  arn       = aws_lambda_function.gitops.arn
  input     = jsonencode({ action = "SWEEP" })
}

resource "aws_lambda_permission" "eventbridge_sweep" {
  statement_id  = "AllowEventBridgeSweep"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.gitops.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.gitops_sweep.arn
}
