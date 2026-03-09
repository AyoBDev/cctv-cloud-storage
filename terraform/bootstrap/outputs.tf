output "state_bucket_arn" {
  description = "ARN of the S3 state bucket"
  value       = data.aws_s3_bucket.tf_state.arn
}

output "state_bucket_name" {
  description = "Name of the S3 state bucket"
  value       = data.aws_s3_bucket.tf_state.bucket
}

output "dynamodb_table_arn" {
  description = "ARN of the DynamoDB lock table"
  value       = data.aws_dynamodb_table.tf_lock.arn
}

output "dynamodb_table_name" {
  description = "Name of the DynamoDB lock table"
  value       = data.aws_dynamodb_table.tf_lock.name
}
