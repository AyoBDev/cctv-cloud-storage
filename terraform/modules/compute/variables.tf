variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "alb_sg_id" {
  type = string
}

variable "ecs_sg_id" {
  type = string
}

variable "ecs_task_execution_role_arn" {
  type = string
}

variable "ecs_task_role_arn" {
  type = string
}

variable "task_cpu" {
  description = "Fargate task CPU units"
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory (MB)"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Number of ECS tasks to run"
  type        = number
  default     = 1
}

variable "cors_origin" {
  description = "Allowed CORS origin for the API"
  type        = string
}

variable "api_domain" {
  description = "Public DNS name for the API (e.g. api.olympusvisions.com). Empty string disables HTTPS/ACM/Route53 wiring and keeps the ALB HTTP-only."
  type        = string
  default     = ""
}

variable "hosted_zone_name" {
  description = "Route 53 hosted zone the api_domain lives in (e.g. olympusvisions.com). Required when api_domain is set."
  type        = string
  default     = ""
}
