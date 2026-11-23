output "function_name" {
  value = aws_lambda_function.face_recognition.function_name
}

output "function_arn" {
  value = aws_lambda_function.face_recognition.arn
}

# Re-exported so other modules (marketplace) call the API at the same URL as
# these Lambdas, without duplicating how that URL is built.
output "internal_api_url" {
  value = var.internal_api_url
}
