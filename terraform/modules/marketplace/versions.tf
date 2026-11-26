terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
      # aws             = the API's region (eu-west-1): queue, Lambda, alarms
      # aws.marketplace = the region AWS Marketplace publishes events in (us-east-1)
      configuration_aliases = [aws.marketplace]
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}
