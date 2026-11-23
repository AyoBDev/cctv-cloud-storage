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

output "marketplace_events_dlq_url" {
  description = "Dead-letter queue for marketplace events that failed delivery"
  value       = module.marketplace.events_dlq_url
}
