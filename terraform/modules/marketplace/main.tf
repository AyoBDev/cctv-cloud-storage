# ---------------------------------------------------------------------------
# AWS Marketplace event delivery
#
# Marketplace publishes agreement and license events only to the default
# event bus in us-east-1, while the API runs in eu-west-1. The path is:
#
#   us-east-1 default bus --rule--> eu-west-1 default bus --rule--> SQS
#     --> Lambda --> POST /internal/marketplace/events
#
# Hopping to the local bus (instead of targeting the queue cross-region) keeps
# every other resource, alarm and log in the API's region.
# ---------------------------------------------------------------------------
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_region" "marketplace" {
  provider = aws.marketplace
}

module "event_pattern" {
  source = "../marketplace-event-pattern"

  agreement_event_types = var.agreement_event_types
}

locals {
  name_prefix = "${var.project}-${var.environment}-marketplace"
  account_id  = data.aws_caller_identity.current.account_id
  ssm_prefix  = "/cctv/${var.environment}"

  agreement_event_pattern = module.event_pattern.event_pattern

  local_default_bus_arn = "arn:aws:events:${data.aws_region.current.name}:${local.account_id}:event-bus/default"
}
