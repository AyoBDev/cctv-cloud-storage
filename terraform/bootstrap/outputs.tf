output "state_bucket_arn" {
  value = aws_s3_bucket.tf_state.arn
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.tf_lock.name
}
