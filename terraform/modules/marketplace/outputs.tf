output "events_queue_url" {
  value = aws_sqs_queue.events.id
}

output "events_dlq_url" {
  value = aws_sqs_queue.events_dlq.id
}

output "function_name" {
  value = aws_lambda_function.events.function_name
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
