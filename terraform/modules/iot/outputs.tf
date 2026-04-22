output "iot_role_alias_arn" {
  description = "ARN of the IoT role alias"
  value       = aws_iot_role_alias.camera.arn
}

output "iot_policy_name" {
  description = "Name of the IoT policy to attach to device certificates"
  value       = aws_iot_policy.camera_streaming.name
}

output "iot_role_arn" {
  description = "ARN of the IAM role used by IoT credential provider"
  value       = aws_iam_role.camera_iot.arn
}

output "iot_thing_type_name" {
  description = "Name of the IoT Thing Type for camera devices"
  value       = aws_iot_thing_type.ip_camera.name
}
