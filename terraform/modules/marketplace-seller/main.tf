# ---------------------------------------------------------------------------
# Seller-account side of the AWS Marketplace integration.
#
# Applied by the seller account's owner, not by the app's staging stack. It:
#   1. lets the app's ECS task role assume a role that may call ResolveCustomer
#      and GetEntitlements for this account's listing;
#   2. forwards this account's Marketplace agreement events to the app
#      account's event bus.
# ---------------------------------------------------------------------------
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

module "event_pattern" {
  source = "../marketplace-event-pattern"

  agreement_event_types = var.agreement_event_types
}

# ---------------------------------------------------------------------------
# 1. API access role (assumed by the app account's ECS task role)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "api_access" {
  name        = var.api_access_role_name
  description = "Assumed by the app's API to resolve Marketplace customers and read entitlements"

  # Trusting one role ARN (not the whole app account) keeps every other
  # principal in the app account out. If that role is ever deleted and
  # recreated, re-apply this module so the trust policy picks up the new role.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = var.app_task_role_arn }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "api_access" {
  name = "marketplace-entitlements"
  role = aws_iam_role.api_access.id

  # These actions do not support resource-level permissions.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "aws-marketplace:ResolveCustomer",
        "aws-marketplace:GetEntitlements",
        # Free listings have no entitlements; access follows the agreement status.
        "aws-marketplace:DescribeAgreement"
      ]
      Resource = "*"
    }]
  })
}

# ---------------------------------------------------------------------------
# 2. Forward Marketplace events to the app account
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "forward_to_app" {
  name          = "marketplace-forward-to-app"
  description   = "Forward AWS Marketplace agreement events to the app account"
  event_pattern = module.event_pattern.event_pattern

  lifecycle {
    # Marketplace only publishes these events in one region; a rule anywhere
    # else would never fire.
    precondition {
      condition     = data.aws_region.current.name == var.marketplace_region
      error_message = "Apply this module with a provider in ${var.marketplace_region}, where AWS Marketplace publishes its events."
    }
  }
}

resource "aws_cloudwatch_event_target" "forward_to_app" {
  rule      = aws_cloudwatch_event_rule.forward_to_app.name
  target_id = "app-account-event-bus"
  arn       = var.app_event_bus_arn
  # Cross-account bus targets created after March 2023 must use a role.
  role_arn = aws_iam_role.event_forwarder.arn
}

resource "aws_iam_role" "event_forwarder" {
  name = var.event_forwarder_role_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

resource "aws_iam_role_policy" "event_forwarder" {
  name = "put-events-app-bus"
  role = aws_iam_role.event_forwarder.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:PutEvents"
      Resource = var.app_event_bus_arn
    }]
  })
}
