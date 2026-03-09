output "ses_domain_verification_token" {
  description = "Add this as a TXT record (_amazonses.<domain>) in your DNS to verify the domain"
  value       = aws_ses_domain_identity.main.verification_token
}

output "ses_dkim_tokens" {
  description = "Add these as CNAME records in DNS for DKIM signing"
  value       = aws_ses_domain_dkim.main.dkim_tokens
}

output "ses_configuration_set_name" {
  value = aws_ses_configuration_set.main.name
}

output "ses_domain_arn" {
  value = aws_ses_domain_identity.main.arn
}
