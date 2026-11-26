# ---------------------------------------------------------------------------
# Cross-account: accept Marketplace events from the seller account
#
# The seller account forwards its agreement events (modules/marketplace-seller)
# to this account's default bus in the Marketplace region. From there the
# forwarding rule in forwarding.tf sends them on to the API region. That rule
# does not filter on `account`, which matters because forwarded events keep the
# seller's account ID.
#
# Note: aws_cloudwatch_event_bus_policy owns the bus's whole resource policy.
# Do not also manage this bus with aws_cloudwatch_event_permission.
# ---------------------------------------------------------------------------
locals {
  marketplace_default_bus_arn = "arn:aws:events:${data.aws_region.marketplace.name}:${local.account_id}:event-bus/default"
}

data "aws_iam_policy_document" "seller_put_events" {
  count = var.seller_account_id == "" ? 0 : 1

  statement {
    sid       = "AllowMarketplaceSellerAccountPutEvents"
    effect    = "Allow"
    actions   = ["events:PutEvents"]
    resources = [local.marketplace_default_bus_arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.seller_account_id}:root"]
    }
  }
}

resource "aws_cloudwatch_event_bus_policy" "seller_put_events" {
  count    = var.seller_account_id == "" ? 0 : 1
  provider = aws.marketplace

  event_bus_name = "default"
  policy         = data.aws_iam_policy_document.seller_put_events[0].json
}
