data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  ssm_prefix = "/cctv/${var.environment}"
}

# ---------------------------------------------------------------------------
# ECS Task Execution Role
# (used by ECS agent to pull images, write logs, read SSM secrets)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "ecs_task_execution" {
  name = "${var.project}-${var.environment}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_ssm" {
  name = "ssm-read-secrets"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${local.region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# ECS Task Role
# (used by the application container itself — KMS, KVS, Rekognition, S3)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "ecs_task" {
  name = "${var.project}-${var.environment}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_app" {
  name = "app-permissions"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # KMS — encrypt/decrypt RTSP URLs
      {
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
        Resource = "*"
      },
      # KVS — manage streams
      {
        Effect = "Allow"
        Action = [
          "kinesisvideo:CreateStream",
          "kinesisvideo:DeleteStream",
          "kinesisvideo:DescribeStream",
          "kinesisvideo:GetDataEndpoint",
          "kinesisvideo:ListStreams",
          "kinesisvideo:PutMedia",
          "kinesisvideo:GetHLSStreamingSessionURL"
        ]
        Resource = "*"
      },
      # Rekognition — manage collections and faces
      {
        Effect = "Allow"
        Action = [
          "rekognition:CreateCollection",
          "rekognition:DeleteCollection",
          "rekognition:IndexFaces",
          "rekognition:DeleteFaces",
          "rekognition:SearchFacesByImage",
          "rekognition:ListFaces"
        ]
        Resource = "*"
      },
      # S3 — video and media buckets
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::${var.video_bucket_name}",
          "arn:aws:s3:::${var.video_bucket_name}/*",
          "arn:aws:s3:::${var.media_bucket_name}",
          "arn:aws:s3:::${var.media_bucket_name}/*"
        ]
      },
      # SES — send email alerts
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "*"
      },
      # CloudWatch Logs
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/cctv/${var.environment}/*"
      },
      # IoT — manage Things and certificates for camera provisioning
      {
        Effect = "Allow"
        Action = [
          "iot:CreateThing",
          "iot:DeleteThing",
          "iot:CreateKeysAndCertificate",
          "iot:UpdateCertificate",
          "iot:DeleteCertificate",
          "iot:AttachPolicy",
          "iot:DetachPolicy",
          "iot:AttachThingPrincipal",
          "iot:DetachThingPrincipal",
          "iot:DescribeEndpoint"
        ]
        Resource = "*"
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Lambda Execution Role
# (face recognition function — KVS, Rekognition, S3, SSM, VPC)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "lambda_execution" {
  name = "${var.project}-${var.environment}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda_app" {
  name = "lambda-app-permissions"
  role = aws_iam_role.lambda_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # KVS — read fragments
      {
        Effect = "Allow"
        Action = [
          "kinesisvideo:GetDataEndpoint",
          "kinesisvideo:GetMedia",
          "kinesisvideo:ListFragments",
          "kinesisvideo:GetMediaForFragmentList"
        ]
        Resource = "*"
      },
      # Rekognition — search faces
      {
        Effect   = "Allow"
        Action   = ["rekognition:SearchFacesByImage"]
        Resource = "*"
      },
      # S3 — write recognition thumbnails
      {
        Effect = "Allow"
        Action = ["s3:PutObject"]
        Resource = [
          "arn:aws:s3:::${var.media_bucket_name}/recognition-events/*"
        ]
      },
      # SSM — read internal API secret
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/internal-api-secret"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
      }
    ]
  })
}
