# ---------------------------------------------------------------------------
# IoT Thing Type
# (shared classification for all camera devices)
# ---------------------------------------------------------------------------
resource "aws_iot_thing_type" "ip_camera" {
  name = "IPCamera"
}

# ---------------------------------------------------------------------------
# IAM Role for IoT Credential Provider
# (assumed by IoT devices via certificate auth to get temporary KVS credentials)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "camera_iot" {
  name = "${var.project}-${var.environment}-camera-iot-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "credentials.iot.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "camera_iot_kvs" {
  name = "kvs-streaming-permissions"
  role = aws_iam_role.camera_iot.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "kinesisvideo:DescribeStream",
        "kinesisvideo:PutMedia",
        "kinesisvideo:TagStream",
        "kinesisvideo:GetDataEndpoint"
      ]
      Resource = "arn:aws:kinesisvideo:${var.aws_region}:${var.aws_account_id}:stream/$${credentials-iot:ThingName}/*"
    }]
  })
}

# ---------------------------------------------------------------------------
# IoT Role Alias
# (maps the IAM role to IoT credential provider)
# ---------------------------------------------------------------------------
resource "aws_iot_role_alias" "camera" {
  alias               = "${var.project}-${var.environment}-camera-iot-role-alias"
  role_arn            = aws_iam_role.camera_iot.arn
  credential_duration = 3600
}

# ---------------------------------------------------------------------------
# IoT Policy
# (allows devices to connect and assume role via certificate)
# ---------------------------------------------------------------------------
resource "aws_iot_policy" "camera_streaming" {
  name = "${var.project}-${var.environment}-CameraStreamingPolicy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = aws_iot_role_alias.camera.arn
      },
      {
        Effect   = "Allow"
        Action   = "iot:AssumeRoleWithCertificate"
        Resource = aws_iot_role_alias.camera.arn
      }
    ]
  })
}
