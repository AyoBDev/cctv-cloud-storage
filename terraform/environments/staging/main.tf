terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  backend "s3" {
    bucket         = "cctv-cloud-storage-tf-state"
    key            = "staging/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "cctv-cloud-terraform-state-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = local.project
      Environment = local.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  project     = "cctv"
  environment = "staging"
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------
module "networking" {
  source = "../../modules/networking"

  project     = local.project
  environment = local.environment
  vpc_cidr    = "10.0.0.0/16"
}

# ---------------------------------------------------------------------------
# Storage (created before IAM so bucket names are available)
# ---------------------------------------------------------------------------
module "storage" {
  source = "../../modules/storage"

  project           = local.project
  environment       = local.environment
  video_bucket_name = "${local.project}-${local.environment}-video"
  media_bucket_name = "${local.project}-${local.environment}-media"
}

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------
module "iam" {
  source = "../../modules/iam"

  project           = local.project
  environment       = local.environment
  video_bucket_name = module.storage.video_bucket_name
  media_bucket_name = module.storage.media_bucket_name
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
module "database" {
  source = "../../modules/database"

  project            = local.project
  environment        = local.environment
  private_subnet_ids = module.networking.private_subnet_ids
  rds_sg_id          = module.networking.rds_sg_id
  redis_sg_id        = module.networking.redis_sg_id
  db_name            = "cctv"
  db_username        = "cctv_admin"
  db_instance_class  = "db.t3.micro"
  redis_node_type    = "cache.t3.micro"
}

# ---------------------------------------------------------------------------
# Compute
# ---------------------------------------------------------------------------
module "compute" {
  source = "../../modules/compute"

  project                     = local.project
  environment                 = local.environment
  vpc_id                      = module.networking.vpc_id
  public_subnet_ids           = module.networking.public_subnet_ids
  private_subnet_ids          = module.networking.private_subnet_ids
  alb_sg_id                   = module.networking.alb_sg_id
  ecs_sg_id                   = module.networking.ecs_sg_id
  ecs_task_execution_role_arn = module.iam.ecs_task_execution_role_arn
  ecs_task_role_arn           = module.iam.ecs_task_role_arn
  task_cpu                    = 256
  task_memory                 = 512
  desired_count               = 1
  cors_origin                 = var.cors_origin
}

# ---------------------------------------------------------------------------
# Lambda
# ---------------------------------------------------------------------------
module "lambda" {
  source = "../../modules/lambda"

  project                   = local.project
  environment               = local.environment
  lambda_execution_role_arn = module.iam.lambda_execution_role_arn
  private_subnet_ids        = module.networking.private_subnet_ids
  lambda_sg_id              = module.networking.lambda_sg_id
  media_bucket_name         = module.storage.media_bucket_name
  internal_api_url          = "http://${module.compute.alb_dns_name}"
  aws_account_id            = data.aws_caller_identity.current.account_id
}

# ---------------------------------------------------------------------------
# IoT (camera device provisioning)
# ---------------------------------------------------------------------------
module "iot" {
  source = "../../modules/iot"

  project        = local.project
  environment    = local.environment
  aws_region     = var.aws_region
  aws_account_id = data.aws_caller_identity.current.account_id
}

# ---------------------------------------------------------------------------
# Notifications (uncomment when SES domain is available)
# ---------------------------------------------------------------------------
# module "notifications" {
#   source = "../../modules/notifications"
#
#   project     = local.project
#   environment = local.environment
#   ses_domain  = var.ses_domain
# }
