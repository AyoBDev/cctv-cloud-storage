# ---------------------------------------------------------------------------
# us-east-1: forward Marketplace events to the API region's default bus
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "forward_to_api_region" {
  provider = aws.marketplace

  name          = "${local.name_prefix}-forward"
  description   = "Forward AWS Marketplace agreement events to the ${data.aws_region.current.name} default bus"
  event_pattern = local.agreement_event_pattern

  lifecycle {
    # Same region on both sides would make this rule forward events to itself.
    precondition {
      condition     = data.aws_region.marketplace.name != data.aws_region.current.name
      error_message = "The aws.marketplace provider must be in a different region from the default provider."
    }
  }

  tags = { Name = "${local.name_prefix}-forward" }
}

resource "aws_cloudwatch_event_target" "forward_to_api_region" {
  provider = aws.marketplace

  rule      = aws_cloudwatch_event_rule.forward_to_api_region.name
  target_id = "api-region-default-bus"
  arn       = local.local_default_bus_arn
  role_arn  = aws_iam_role.event_forwarder.arn
}

# Cross-region bus targets require a role that EventBridge assumes to call
# PutEvents on the destination bus.
resource "aws_iam_role" "event_forwarder" {
  name = "${local.name_prefix}-forwarder"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
      }
    }]
  })
}

resource "aws_iam_role_policy" "event_forwarder" {
  name = "put-events-api-region"
  role = aws_iam_role.event_forwarder.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:PutEvents"
      Resource = local.local_default_bus_arn
    }]
  })
}
