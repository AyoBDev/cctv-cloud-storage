# ---------------------------------------------------------------------------
# API region: default bus rule -> SQS queue (with DLQ)
# ---------------------------------------------------------------------------
locals {
  # AWS guidance: visibility timeout of at least 6x the consumer's timeout, so
  # a message is not redelivered while a slow invocation still holds it.
  queue_visibility_timeout_seconds = var.lambda_timeout_seconds * 6
}

resource "aws_sqs_queue" "events_dlq" {
  name                      = "${local.name_prefix}-events-dlq"
  message_retention_seconds = var.dlq_retention_seconds
  sqs_managed_sse_enabled   = true

  tags = { Name = "${local.name_prefix}-events-dlq" }
}

resource "aws_sqs_queue" "events" {
  name                       = "${local.name_prefix}-events"
  visibility_timeout_seconds = local.queue_visibility_timeout_seconds
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.events_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = { Name = "${local.name_prefix}-events" }
}

resource "aws_sqs_queue_redrive_allow_policy" "events_dlq" {
  queue_url = aws_sqs_queue.events_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.events.arn]
  })
}

resource "aws_cloudwatch_event_rule" "events_to_queue" {
  name          = "${local.name_prefix}-events"
  description   = "Queue AWS Marketplace agreement events (forwarded from ${data.aws_region.marketplace.name}) for delivery to the API"
  event_pattern = local.agreement_event_pattern

  tags = { Name = "${local.name_prefix}-events" }
}

resource "aws_cloudwatch_event_target" "events_to_queue" {
  rule      = aws_cloudwatch_event_rule.events_to_queue.name
  target_id = "marketplace-events-queue"
  arn       = aws_sqs_queue.events.arn
}

resource "aws_sqs_queue_policy" "events" {
  queue_url = aws_sqs_queue.events.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowMarketplaceEventRule"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.events.arn
      Condition = {
        ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.events_to_queue.arn }
      }
    }]
  })
}
