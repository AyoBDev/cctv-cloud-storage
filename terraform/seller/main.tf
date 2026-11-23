# ---------------------------------------------------------------------------
# Seller account stack: apply with credentials for the AWS account that owns
# the Marketplace listing (not the app account). See README.md.
# ---------------------------------------------------------------------------
terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Fill in with a state bucket in the seller account, or remove this block
  # to keep state locally.
  backend "s3" {
    # bucket         = "<seller-state-bucket>"
    # key            = "marketplace-seller/terraform.tfstate"
    # region         = "<bucket-region>"
    # dynamodb_table = "<lock-table>"
    # encrypt        = true
  }
}

# Marketplace publishes agreement events only in us-east-1, so the forwarding
# rule must live there. IAM is global, so the role is unaffected.
provider "aws" {
  region = var.marketplace_region

  default_tags {
    tags = {
      Project   = "cctv"
      Component = "marketplace-seller"
      ManagedBy = "terraform"
    }
  }
}

module "marketplace_seller" {
  source = "../modules/marketplace-seller"

  app_task_role_arn  = var.app_task_role_arn
  app_event_bus_arn  = var.app_event_bus_arn
  marketplace_region = var.marketplace_region
}
