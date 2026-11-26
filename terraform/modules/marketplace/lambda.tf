# ---------------------------------------------------------------------------
# Delivery Lambda (lambda/marketplace-events)
# One function, two triggers: the queue (events) and an hourly schedule
# (reconcile). Placeholder ZIP; real code is deployed separately, like the
# other Lambdas in this repo.
# ---------------------------------------------------------------------------
locals {
  function_name = "${local.name_prefix}-events"
}

data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200 });"
    filename = "index.js"
  }
}

resource "aws_cloudwatch_log_group" "events" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "events" {
  function_name = local.function_name
  role          = aws_iam_role.events_lambda.arn
  handler       = "index.handler"
  runtime       = var.lambda_runtime
  timeout       = var.lambda_timeout_seconds
  memory_size   = 256

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  # Same subnets as the other Lambdas so it reaches the API the same way.
  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [var.lambda_sg_id]
  }

  environment {
    variables = {
      ENVIRONMENT      = var.environment
      INTERNAL_API_URL = var.internal_api_url
      SSM_PREFIX       = local.ssm_prefix
    }
  }

  depends_on = [aws_cloudwatch_log_group.events]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = { Name = local.function_name }
}

resource "aws_lambda_event_source_mapping" "events" {
  event_source_arn        = aws_sqs_queue.events.arn
  function_name           = aws_lambda_function.events.arn
  batch_size              = var.sqs_batch_size
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.max_concurrent_deliveries
  }
}

# ---------------------------------------------------------------------------
# Hourly reconcile: safety net for missed or out-of-order events
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "reconcile" {
  name                = "${local.name_prefix}-reconcile"
  description         = "Trigger the marketplace Lambda to reconcile all customer entitlements"
  schedule_expression = var.reconcile_schedule_expression

  tags = { Name = "${local.name_prefix}-reconcile" }
}

resource "aws_cloudwatch_event_target" "reconcile" {
  rule      = aws_cloudwatch_event_rule.reconcile.name
  target_id = "marketplace-reconcile"
  arn       = aws_lambda_function.events.arn

  # Must match RECONCILE_ACTION in lambda/marketplace-events/index.ts
  input = jsonencode({ action = "reconcile" })
}

resource "aws_lambda_permission" "allow_eventbridge_reconcile" {
  statement_id  = "AllowEventBridgeMarketplaceReconcile"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.events.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reconcile.arn
}

# ---------------------------------------------------------------------------
# Execution role: its own role, scoped to this queue and the internal secret
# ---------------------------------------------------------------------------
resource "aws_iam_role" "events_lambda" {
  name = "${local.name_prefix}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Logs + VPC network interfaces
resource "aws_iam_role_policy_attachment" "events_lambda_vpc" {
  role       = aws_iam_role.events_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "events_lambda" {
  name = "marketplace-events"
  role = aws_iam_role.events_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ChangeMessageVisibility"
        ]
        Resource = aws_sqs_queue.events.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${data.aws_region.current.name}:${local.account_id}:parameter${local.ssm_prefix}/internal-api-secret"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${data.aws_region.current.name}.amazonaws.com" }
        }
      }
    ]
  })
}
