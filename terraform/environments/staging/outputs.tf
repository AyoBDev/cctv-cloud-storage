output "alb_dns_name" {
  description = "Public URL of the staging API"
  value       = "http://${module.compute.alb_dns_name}"
}

output "ecr_repository_url" {
  description = "ECR URL — tag and push your Docker image here"
  value       = module.compute.ecr_repository_url
}

# Uncomment when notifications module is enabled
# output "ses_verification_token" {
#   description = "Add as DNS TXT record to verify SES domain"
#   value       = module.notifications.ses_domain_verification_token
# }
#
# output "ses_dkim_tokens" {
#   description = "Add as DNS CNAME records for DKIM"
#   value       = module.notifications.ses_dkim_tokens
# }
