# ---------------------------------------------------------------------------
# EventBridge pattern for AWS Marketplace agreement/license events.
# Shared by the app-account (marketplace) and seller-account
# (marketplace-seller) modules so both always match the same events.
# No resources: inputs in, pattern JSON out.
# ---------------------------------------------------------------------------
variable "agreement_event_types" {
  description = "AWS Marketplace event names. Each is matched in both its '- Manufacturer' and '- Proposer' variant."
  type        = list(string)
  nullable    = false # callers pass null to get this default
  default = [
    "Purchase Agreement Created",
    "Purchase Agreement Amended",
    "Purchase Agreement Ended",
    "License Updated",
    "License Deprovisioned",
    "Purchase Agreement Free Trial Converted",
  ]
}

locals {
  # AWS sends the Proposer variant when the seller is also the proposer (our
  # case for private offers), and the Manufacturer variant otherwise.
  detail_type_suffixes = ["Manufacturer", "Proposer"]
}

output "event_pattern" {
  # Deliberately no `account` filter: in the cross-account setup the events
  # carry the seller account's ID, not the account the rule lives in.
  value = jsonencode({
    source = ["aws.agreement-marketplace"]
    detail-type = flatten([
      for event_type in var.agreement_event_types : [
        for suffix in local.detail_type_suffixes : "${event_type} - ${suffix}"
      ]
    ])
  })
}
