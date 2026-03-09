terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Bootstrap itself uses local state — the S3 bucket/DynamoDB table already exist.
  # All other environments use this bucket as their remote backend.
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "cctv-cloud-storage"
      ManagedBy   = "terraform"
      Environment = "bootstrap"
    }
  }
}

# ---------------------------------------------------------------------------
# Confirm the S3 state bucket exists (data source only — bucket pre-created)
# ---------------------------------------------------------------------------
data "aws_s3_bucket" "tf_state" {
  bucket = var.state_bucket_name
}

# ---------------------------------------------------------------------------
# Confirm the DynamoDB lock table exists (data source only — table pre-created)
# ---------------------------------------------------------------------------
data "aws_dynamodb_table" "tf_lock" {
  name = var.dynamodb_table_name
}
