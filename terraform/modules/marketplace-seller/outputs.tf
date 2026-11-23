output "api_access_role_arn" {
  description = "Send to the app team: set as marketplace_seller_role_arn in the app's staging stack"
  value       = aws_iam_role.api_access.arn
}

output "seller_account_id" {
  description = "Send to the app team: set as marketplace_seller_account_id in the app's staging stack"
  value       = data.aws_caller_identity.current.account_id
}
