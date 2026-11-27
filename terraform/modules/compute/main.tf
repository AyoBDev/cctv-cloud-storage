data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  ssm_prefix = "/cctv/${var.environment}"
}

# ---------------------------------------------------------------------------
# ECR Repository
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "api" {
  name                 = "${var.project}-${var.environment}-api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "${var.project}-${var.environment}-api" }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch Log Group
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "api" {
  name              = "/cctv/${var.environment}/api"
  retention_in_days = 30

  tags = { Name = "${var.project}-${var.environment}-api-logs" }
}

# ---------------------------------------------------------------------------
# ECS Cluster
# ---------------------------------------------------------------------------
resource "aws_ecs_cluster" "main" {
  name = "${var.project}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${var.project}-${var.environment}-cluster" }
}

# ---------------------------------------------------------------------------
# ALB
# ---------------------------------------------------------------------------
resource "aws_lb" "main" {
  name               = "${var.project}-${var.environment}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_sg_id]
  subnets            = var.public_subnet_ids

  tags = { Name = "${var.project}-${var.environment}-alb" }
}

resource "aws_lb_target_group" "api" {
  name        = "${var.project}-${var.environment}-api-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/health"
    matcher             = "200"
  }

  tags = { Name = "${var.project}-${var.environment}-api-tg" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # When a custom HTTPS domain is configured, redirect all HTTP → HTTPS.
  # Otherwise fall back to forwarding plain HTTP to the API (dev/no-domain).
  dynamic "default_action" {
    for_each = var.api_domain == "" ? [1] : []
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.api.arn
    }
  }

  dynamic "default_action" {
    for_each = var.api_domain == "" ? [] : [1]
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# HTTPS: ACM certificate (DNS-validated) + 443 listener + Route 53 alias
# All gated on var.api_domain being set, so the module still applies without
# a custom domain. DNS records live in the EXISTING hosted zone (looked up,
# not created) so the working frontend zone is never touched.
# ---------------------------------------------------------------------------
data "aws_route53_zone" "public" {
  count        = var.api_domain == "" ? 0 : 1
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "api" {
  count             = var.api_domain == "" ? 0 : 1
  domain_name       = var.api_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.project}-${var.environment}-api-cert" }
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.api_domain == "" ? {} : {
    for dvo in aws_acm_certificate.api[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = data.aws_route53_zone.public[0].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  count                   = var.api_domain == "" ? 0 : 1
  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_lb_listener" "https" {
  count             = var.api_domain == "" ? 0 : 1
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# A-record alias: api.olympusvisions.com → ALB
resource "aws_route53_record" "api" {
  count   = var.api_domain == "" ? 0 : 1
  zone_id = data.aws_route53_zone.public[0].zone_id
  name    = var.api_domain
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# ---------------------------------------------------------------------------
# ECS Task Definition
# Secrets pulled from SSM at container startup via valueFrom
# ---------------------------------------------------------------------------
resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project}-${var.environment}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = var.ecs_task_execution_role_arn
  task_role_arn            = var.ecs_task_role_arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${aws_ecr_repository.api.repository_url}:latest"
    essential = true

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = var.environment },
      { name = "PORT", value = "3000" },
      { name = "HOST", value = "0.0.0.0" },
      { name = "DATABASE_SSL", value = "true" },
      { name = "AWS_REGION", value = data.aws_region.current.name },
      { name = "JWT_ACCESS_EXPIRES_IN", value = "15m" },
      { name = "JWT_REFRESH_EXPIRES_IN", value = "7d" },
      { name = "RATE_LIMIT_MAX", value = "100" },
      { name = "RATE_LIMIT_WINDOW", value = "60000" },
      { name = "LOG_LEVEL", value = "info" },
      { name = "CORS_ORIGIN", value = var.cors_origin },
      { name = "MARKETPLACE_PRODUCT_CODE", value = var.marketplace_product_code },
      { name = "MARKETPLACE_CAMERA_DIMENSION", value = var.marketplace_camera_dimension },
      { name = "MARKETPLACE_PRICING_MODEL", value = var.marketplace_pricing_model },
      { name = "MARKETPLACE_FREE_CAMERA_LIMIT", value = tostring(var.marketplace_free_camera_limit) },
      { name = "MARKETPLACE_ENTITLEMENT_REGION", value = var.marketplace_entitlement_region },
      { name = "MARKETPLACE_REGISTRATION_PAGE_URL", value = var.marketplace_registration_page_url },
      { name = "MARKETPLACE_SELLER_ROLE_ARN", value = var.marketplace_seller_role_arn }
    ]

    secrets = [
      {
        name      = "DATABASE_URL"
        valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/db-url"
      },
      {
        name      = "REDIS_URL"
        valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/redis-url"
      },
      {
        name      = "JWT_PRIVATE_KEY"
        valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/jwt-private-key"
      },
      {
        name      = "JWT_PUBLIC_KEY"
        valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/jwt-public-key"
      },
      {
        name      = "INTERNAL_API_SECRET"
        valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/internal-api-secret"
      },
      {
        name      = "IOT_POLICY_NAME"
        valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/iot-policy-name"
      },
      {
        name      = "IOT_ROLE_ALIAS"
        valueFrom = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/iot-role-alias"
      }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

# ---------------------------------------------------------------------------
# ECS Service
# ---------------------------------------------------------------------------
resource "aws_ecs_service" "api" {
  name            = "${var.project}-${var.environment}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.http]

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
