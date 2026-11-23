variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "lambda_sg_id" {
  type = string
}

variable "internal_api_url" {
  description = "Base URL the Lambda uses to reach the API's /internal routes"
  type        = string
}

variable "agreement_event_types" {
  description = "AWS Marketplace agreement/license event names to deliver. Each is matched in both its '- Manufacturer' and '- Proposer' variant."
  type        = list(string)
  default = [
    "Purchase Agreement Created",
    "Purchase Agreement Amended",
    "Purchase Agreement Ended",
    "License Updated",
    "License Deprovisioned",
    "Purchase Agreement Free Trial Converted",
  ]
}

variable "reconcile_schedule_expression" {
  description = "How often the API re-reads every marketplace customer's entitlements"
  type        = string
  default     = "rate(1 hour)"
}

variable "max_receive_count" {
  description = "Delivery attempts per event before it moves to the dead-letter queue"
  type        = number
  default     = 5
}

variable "lambda_runtime" {
  type    = string
  default = "nodejs22.x"
}

variable "lambda_timeout_seconds" {
  type    = number
  default = 60
}

variable "sqs_batch_size" {
  type    = number
  default = 10
}

variable "max_concurrent_deliveries" {
  description = "Upper bound on concurrent Lambda invocations from the queue, so a burst of events cannot flood the API (minimum 2)"
  type        = number
  default     = 2
}

variable "dlq_retention_seconds" {
  description = "How long failed events stay in the DLQ for inspection and redrive"
  type        = number
  default     = 1209600 # 14 days, the SQS maximum
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "alarm_email" {
  description = "Email subscribed to marketplace alarms. Empty creates the topic without a subscription."
  type        = string
  default     = ""
}
