# AWS Marketplace settings passed to the API container.
# Kept in their own file so they stay separate from the core compute variables.

variable "marketplace_product_code" {
  description = "AWS Marketplace product code of the SaaS listing. Empty until the listing exists."
  type        = string
  default     = ""
}

variable "marketplace_camera_dimension" {
  description = "Entitlement dimension key that holds the purchased camera count"
  type        = string
  default     = "cameras"
}

variable "marketplace_entitlement_region" {
  description = "Region of the AWS Marketplace Entitlement/Metering APIs"
  type        = string
  default     = "us-east-1"
}

variable "marketplace_registration_page_url" {
  description = "Page AWS Marketplace sends buyers to after subscribing"
  type        = string
  default     = "https://www.olympusvisions.com/marketplace/register"
}
