output "db_endpoint" {
  value = aws_db_instance.postgres.address
}

output "db_port" {
  value = aws_db_instance.postgres.port
}

output "db_name" {
  value = aws_db_instance.postgres.db_name
}

output "redis_endpoint" {
  value = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "db_url_ssm_arn" {
  description = "SSM parameter ARN for the full DB connection URL"
  value       = aws_ssm_parameter.db_url.arn
}

output "redis_url_ssm_arn" {
  description = "SSM parameter ARN for the Redis URL"
  value       = aws_ssm_parameter.redis_url.arn
}
