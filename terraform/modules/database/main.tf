data "aws_ssm_parameter" "db_password" {
  name            = "/cctv/${var.environment}/db-password"
  with_decryption = true
}

# ---------------------------------------------------------------------------
# RDS Subnet Group
# ---------------------------------------------------------------------------
resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-${var.environment}-db-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = { Name = "${var.project}-${var.environment}-db-subnet-group" }
}

# ---------------------------------------------------------------------------
# RDS PostgreSQL
# ---------------------------------------------------------------------------
resource "aws_db_instance" "postgres" {
  identifier        = "${var.project}-${var.environment}-postgres"
  engine            = "postgres"
  engine_version    = "16.6"
  instance_class    = var.db_instance_class
  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username
  password = data.aws_ssm_parameter.db_password.value

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.rds_sg_id]
  publicly_accessible    = false
  skip_final_snapshot    = var.environment != "production"

  backup_retention_period = var.environment == "production" ? 7 : 1
  multi_az                = var.environment == "production"

  tags = { Name = "${var.project}-${var.environment}-postgres" }
}

# ---------------------------------------------------------------------------
# ElastiCache Subnet Group
# ---------------------------------------------------------------------------
resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project}-${var.environment}-redis-subnet-group"
  subnet_ids = var.private_subnet_ids
}

# ---------------------------------------------------------------------------
# ElastiCache Redis
# ---------------------------------------------------------------------------
resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "${var.project}-${var.environment}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [var.redis_sg_id]

  tags = { Name = "${var.project}-${var.environment}-redis" }
}

# ---------------------------------------------------------------------------
# Store DB connection URL in SSM (non-secret — uses DB password from SSM)
# ---------------------------------------------------------------------------
resource "aws_ssm_parameter" "db_url" {
  name  = "/cctv/${var.environment}/db-url"
  type  = "SecureString"
  value = "postgres://${var.db_username}:${data.aws_ssm_parameter.db_password.value}@${aws_db_instance.postgres.address}:5432/${var.db_name}?sslmode=no-verify"

  tags = { Environment = var.environment }
}

resource "aws_ssm_parameter" "redis_url" {
  name  = "/cctv/${var.environment}/redis-url"
  type  = "String"
  value = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379"

  tags = { Environment = var.environment }
}
