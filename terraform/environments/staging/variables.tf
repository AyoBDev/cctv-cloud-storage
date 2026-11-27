variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
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

variable "api_domain" {
  description = "Public DNS name for the API. Empty disables HTTPS/ACM/Route53 wiring."
  type        = string
  default     = "api.olympusvisions.com"
}

variable "hosted_zone_name" {
  description = "Route 53 hosted zone that api_domain lives in."
  type        = string
  default     = "olympusvisions.com"
}
