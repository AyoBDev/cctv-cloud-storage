data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# Placeholder ZIP — real code deployed separately via CI
# ---------------------------------------------------------------------------
data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200 });"
    filename = "index.js"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Log Group
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "face_recognition" {
  name              = "/aws/lambda/${var.project}-${var.environment}-face-recognition"
  retention_in_days = 14
}

# ---------------------------------------------------------------------------
# Lambda Function
# ---------------------------------------------------------------------------
resource "aws_lambda_function" "face_recognition" {
  function_name = "${var.project}-${var.environment}-face-recognition"
  role          = var.lambda_execution_role_arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 30
  memory_size   = 512

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

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

  depends_on = [aws_cloudwatch_log_group.face_recognition]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = { Name = "${var.project}-${var.environment}-face-recognition" }
}
