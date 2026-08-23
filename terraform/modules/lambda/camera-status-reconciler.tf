# ---------------------------------------------------------------------------
# Camera Status Reconciler Lambda — probes each active KVS stream for recent
# fragments and reconciles camera status (online/offline) via the internal API.
# Runs every minute. Reuses the shared lambda execution role, which already
# grants kinesisvideo:GetDataEndpoint + ListFragments and ssm:GetParameter on
# the internal-api-secret (see terraform/modules/iam/main.tf, lambda_app).
# ---------------------------------------------------------------------------
data "archive_file" "camera_status_reconciler_placeholder" {
  type        = "zip"
  output_path = "${path.module}/camera-status-reconciler-placeholder.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200 });"
    filename = "index.js"
  }
}

resource "aws_cloudwatch_log_group" "camera_status_reconciler" {
  name              = "/aws/lambda/${var.project}-${var.environment}-camera-status-reconciler"
  retention_in_days = 14
}

resource "aws_lambda_function" "camera_status_reconciler" {
  function_name = "${var.project}-${var.environment}-camera-status-reconciler"
  role          = var.lambda_execution_role_arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 120
  memory_size   = 256

  filename         = data.archive_file.camera_status_reconciler_placeholder.output_path
  source_code_hash = data.archive_file.camera_status_reconciler_placeholder.output_base64sha256

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [var.lambda_sg_id]
  }

  environment {
    variables = {
      ENVIRONMENT                = var.environment
      AWS_ACCOUNT_ID             = var.aws_account_id
      INTERNAL_API_URL           = var.internal_api_url
      SSM_PREFIX                 = "/cctv/${var.environment}"
      RECONCILE_LOOKBACK_SECONDS = "120"
    }
  }

  depends_on = [aws_cloudwatch_log_group.camera_status_reconciler]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = { Name = "${var.project}-${var.environment}-camera-status-reconciler" }
}

# ---------------------------------------------------------------------------
# EventBridge Rule — Trigger every minute
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "camera_status_reconciler" {
  name                = "${var.project}-${var.environment}-camera-status-reconciler"
  description         = "Trigger camera status reconciler Lambda every minute"
  schedule_expression = "rate(1 minute)"

  tags = { Name = "${var.project}-${var.environment}-camera-status-reconciler" }
}

resource "aws_cloudwatch_event_target" "camera_status_reconciler" {
  rule      = aws_cloudwatch_event_rule.camera_status_reconciler.name
  target_id = "camera-status-reconciler"
  arn       = aws_lambda_function.camera_status_reconciler.arn
}

resource "aws_lambda_permission" "allow_eventbridge_reconciler" {
  statement_id  = "AllowEventBridgeCameraStatusReconciler"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.camera_status_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.camera_status_reconciler.arn
}
