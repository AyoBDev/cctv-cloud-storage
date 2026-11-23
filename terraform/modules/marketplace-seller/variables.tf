variable "app_task_role_arn" {
  description = "ARN of the app account's ECS task role, the only principal allowed to assume the API access role"
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/.+$", var.app_task_role_arn))
    error_message = "app_task_role_arn must be an IAM role ARN."
  }
}

variable "app_event_bus_arn" {
  description = "ARN of the app account's default event bus to forward Marketplace events to (its us-east-1 default bus)"
  type        = string

  validation {
    condition     = can(regex("^arn:aws:events:[a-z0-9-]+:[0-9]{12}:event-bus/default$", var.app_event_bus_arn))
    error_message = "app_event_bus_arn must be a default event bus ARN."
  }
}

variable "api_access_role_name" {
  description = "Name of the role the app's API assumes to call the Marketplace APIs"
  type        = string
  default     = "marketplace-api-access"
}

variable "event_forwarder_role_name" {
  description = "Name of the role EventBridge uses to send events to the app account"
  type        = string
  default     = "marketplace-event-forwarder"
}

variable "marketplace_region" {
  description = "Region where AWS Marketplace publishes agreement events. The provider passed to this module must be in this region."
  type        = string
  default     = "us-east-1"
}

variable "agreement_event_types" {
  description = "Override the Marketplace event names to forward. null uses the shared list in modules/marketplace-event-pattern."
  type        = list(string)
  default     = null
}
