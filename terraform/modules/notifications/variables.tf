variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "ses_domain" {
  description = "Domain to verify with SES for sending emails (e.g. cctv-cloud.local)"
  type        = string
}
