# ---------------------------------------------------------------------------
# SES Email Identity
# (domain verification requires DNS TXT record — see outputs for value)
# ---------------------------------------------------------------------------
resource "aws_ses_domain_identity" "main" {
  domain = var.ses_domain
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

# ---------------------------------------------------------------------------
# SES Configuration Set
# (tracks bounces and complaints — important for production sending)
# ---------------------------------------------------------------------------
resource "aws_ses_configuration_set" "main" {
  name = "${var.project}-${var.environment}-config-set"

  delivery_options {
    tls_policy = "Require"
  }
}

# ---------------------------------------------------------------------------
# SNS Topic for bounce/complaint notifications (optional but recommended)
# ---------------------------------------------------------------------------
resource "aws_sns_topic" "ses_notifications" {
  name = "${var.project}-${var.environment}-ses-notifications"
}

resource "aws_ses_identity_notification_topic" "bounce" {
  topic_arn                = aws_sns_topic.ses_notifications.arn
  notification_type        = "Bounce"
  identity                 = aws_ses_domain_identity.main.domain
  include_original_headers = false
}

resource "aws_ses_identity_notification_topic" "complaint" {
  topic_arn                = aws_sns_topic.ses_notifications.arn
  notification_type        = "Complaint"
  identity                 = aws_ses_domain_identity.main.domain
  include_original_headers = false
}
