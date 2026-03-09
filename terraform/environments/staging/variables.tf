variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-2"
}

variable "cors_origin" {
  description = "Allowed CORS origin (frontend URL)"
  type        = string
  default     = "http://localhost:3001"
}

variable "ses_domain" {
  description = "Domain to verify with SES for sending email alerts"
  type        = string
  default     = ""
}
