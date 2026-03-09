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
