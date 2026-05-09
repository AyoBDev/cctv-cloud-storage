# ---------------------------------------------------------------------------
# EventBridge Rule — Hourly purge of expired unknown faces
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "purge_unknowns" {
  name                = "${var.project}-${var.environment}-purge-unknowns"
  description         = "Trigger face recognition Lambda hourly to purge expired unknown faces"
  schedule_expression = "rate(1 hour)"

  tags = { Name = "${var.project}-${var.environment}-purge-unknowns" }
}

resource "aws_cloudwatch_event_target" "purge_unknowns" {
  rule      = aws_cloudwatch_event_rule.purge_unknowns.name
  target_id = "face-recognition-purge"
  arn       = aws_lambda_function.face_recognition.arn

  input = jsonencode({ action = "purge_unknowns" })
}

resource "aws_lambda_permission" "allow_eventbridge_purge" {
  statement_id  = "AllowEventBridgePurge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.face_recognition.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.purge_unknowns.arn
}
