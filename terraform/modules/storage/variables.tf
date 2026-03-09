variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "video_bucket_name" {
  description = "Name for the S3 video storage bucket"
  type        = string
}

variable "media_bucket_name" {
  description = "Name for the S3 media assets bucket"
  type        = string
}
