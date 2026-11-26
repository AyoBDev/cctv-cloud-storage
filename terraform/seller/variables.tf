variable "app_task_role_arn" {
  description = "App account's ECS task role ARN (from the app team)"
  type        = string
}

variable "app_event_bus_arn" {
  description = "App account's us-east-1 default event bus ARN (from the app team)"
  type        = string
}

variable "marketplace_region" {
  description = "Region where AWS Marketplace publishes agreement events"
  type        = string
  default     = "us-east-1"
}
