variable "project" {
  description = "Project name"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "video_bucket_name" {
  description = "S3 video bucket name (for task role policy)"
  type        = string
}

variable "media_bucket_name" {
  description = "S3 media assets bucket name (for task role policy)"
  type        = string
}

variable "marketplace_seller_role_arn" {
  description = "Seller-account role the API assumes for Marketplace calls. Empty means same-account (no AssumeRole grant)."
  type        = string
  default     = ""
}
