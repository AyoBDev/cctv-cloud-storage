# ---------------------------------------------------------------------------
# Recording Archiver Lambda — archives KVS clips to S3 every 5 minutes
# ---------------------------------------------------------------------------
data "archive_file" "recording_archiver_placeholder" {
  type        = "zip"
  output_path = "${path.module}/recording-archiver-placeholder.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200 });"
    filename = "index.js"
  }
}

resource "aws_cloudwatch_log_group" "recording_archiver" {
  name              = "/aws/lambda/${var.project}-${var.environment}-recording-archiver"
  retention_in_days = 14
}

resource "aws_lambda_function" "recording_archiver" {
  function_name = "${var.project}-${var.environment}-recording-archiver"
  role          = var.lambda_execution_role_arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 120
  memory_size   = 1024

  filename         = data.archive_file.recording_archiver_placeholder.output_path
  source_code_hash = data.archive_file.recording_archiver_placeholder.output_base64sha256

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [var.lambda_sg_id]
  }

  environment {
    variables = {
      ENVIRONMENT      = var.environment
      AWS_ACCOUNT_ID   = var.aws_account_id
      MEDIA_BUCKET     = var.media_bucket_name
      INTERNAL_API_URL = var.internal_api_url
      SSM_PREFIX       = "/cctv/${var.environment}"
    }
  }

  depends_on = [aws_cloudwatch_log_group.recording_archiver]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = { Name = "${var.project}-${var.environment}-recording-archiver" }
}

# ---------------------------------------------------------------------------
# EventBridge Rule — Trigger every 5 minutes
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "recording_archiver" {
  name                = "${var.project}-${var.environment}-recording-archiver"
  description         = "Trigger recording archiver Lambda every 5 minutes"
  schedule_expression = "rate(5 minutes)"

  tags = { Name = "${var.project}-${var.environment}-recording-archiver" }
}

resource "aws_cloudwatch_event_target" "recording_archiver" {
  rule      = aws_cloudwatch_event_rule.recording_archiver.name
  target_id = "recording-archiver"
  arn       = aws_lambda_function.recording_archiver.arn
}

resource "aws_lambda_permission" "allow_eventbridge_recording" {
  statement_id  = "AllowEventBridgeRecordingArchiver"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.recording_archiver.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.recording_archiver.arn
}
