# ---------------------------------------------------------------------------
# AWS Marketplace (SaaS contract listing)
# Kept in its own file to stay apart from the core staging wiring in main.tf.
# ---------------------------------------------------------------------------

# AWS Marketplace publishes agreement/license events only in us-east-1, and its
# Entitlement API lives there too.
provider "aws" {
  alias  = "marketplace"
  region = var.marketplace_region

  default_tags {
    tags = {
      Project     = local.project
      Environment = local.environment
      ManagedBy   = "terraform"
    }
  }
}

module "marketplace" {
  source = "../../modules/marketplace"

  providers = {
    aws             = aws
    aws.marketplace = aws.marketplace
  }

  project            = local.project
  environment        = local.environment
  private_subnet_ids = module.networking.private_subnet_ids
  lambda_sg_id       = module.networking.lambda_sg_id
  internal_api_url   = module.lambda.internal_api_url
  alarm_email        = var.marketplace_alarm_email
  seller_account_id  = var.marketplace_seller_account_id
}

variable "marketplace_region" {
  description = "Region where AWS Marketplace publishes events and serves the Entitlement API"
  type        = string
  default     = "us-east-1"
}

variable "marketplace_product_code" {
  description = "Product code of the AWS Marketplace listing. Set once the listing exists."
  type        = string
  default     = ""
}

variable "marketplace_camera_dimension" {
  description = "Entitlement dimension key that holds the purchased camera count"
  type        = string
  default     = "cameras"
}

variable "marketplace_pricing_model" {
  description = "Pricing model of the listing: contract (camera entitlements) or free (fixed camera limit while the agreement is active)"
  type        = string
  default     = "contract"

  validation {
    condition     = contains(["contract", "free"], var.marketplace_pricing_model)
    error_message = "marketplace_pricing_model must be contract or free."
  }
}

variable "marketplace_free_camera_limit" {
  description = "Cameras each buyer of a free listing may have"
  type        = number
  default     = 5
}

variable "marketplace_free_access_check" {
  description = "Free listings only: 'events' (active until a Purchase Agreement Ended event; no extra permission) or 'agreement' (DescribeAgreement; needs that permission on the seller role)"
  type        = string
  default     = "events"

  validation {
    condition     = contains(["events", "agreement"], var.marketplace_free_access_check)
    error_message = "marketplace_free_access_check must be events or agreement."
  }
}

variable "marketplace_registration_page_url" {
  description = "Registration (fulfillment) URL configured on the listing"
  type        = string
  default     = "https://www.olympusvisions.com/marketplace/register"
}

variable "marketplace_alarm_email" {
  description = "Email for marketplace delivery alarms (DLQ not empty). Empty skips the subscription."
  type        = string
  default     = ""
}

variable "marketplace_seller_account_id" {
  description = "Seller account that owns the listing, when it is not this account. Allows it to send events to our Marketplace-region bus. Empty for same-account."
  type        = string
  default     = ""
}

variable "marketplace_seller_role_arn" {
  description = "Seller-account role (from terraform/seller) the API assumes for Marketplace calls. Empty for same-account."
  type        = string
  default     = ""
}

# Values the seller account needs for terraform/seller.
output "marketplace_app_task_role_arn" {
  description = "Seller stack input app_task_role_arn"
  value       = module.iam.ecs_task_role_arn
}

output "marketplace_app_event_bus_arn" {
  description = "Seller stack input app_event_bus_arn"
  value       = module.marketplace.marketplace_region_event_bus_arn
}

output "marketplace_events_dlq_url" {
  description = "Dead-letter queue for marketplace events that failed delivery"
  value       = module.marketplace.events_dlq_url
}
