output "api_access_role_arn" {
  description = "Send to the app team (marketplace_seller_role_arn)"
  value       = module.marketplace_seller.api_access_role_arn
}

output "seller_account_id" {
  description = "Send to the app team (marketplace_seller_account_id)"
  value       = module.marketplace_seller.seller_account_id
}
