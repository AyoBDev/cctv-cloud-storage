variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "lambda_execution_role_arn" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "lambda_sg_id" {
  type = string
}

variable "media_bucket_name" {
  type = string
}

variable "internal_api_url" {
  description = "Base URL for the internal API (ALB DNS)"
  type        = string
}

variable "aws_account_id" {
  type = string
}
