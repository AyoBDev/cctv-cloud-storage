# ---------------------------------------------------------------------------
# Video Bucket — stores KVS fragments and recordings
# Path pattern: orgs/{orgId}/cameras/{camId}/{date}/
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "video" {
  bucket = var.video_bucket_name

  tags = { Name = var.video_bucket_name, Purpose = "video-storage" }
}

resource "aws_s3_bucket_versioning" "video" {
  bucket = aws_s3_bucket.video.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "video" {
  bucket = aws_s3_bucket.video.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "video" {
  bucket                  = aws_s3_bucket.video.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "video" {
  bucket = aws_s3_bucket.video.id

  rule {
    id     = "transition-to-glacier"
    status = "Enabled"

    filter {
      prefix = "orgs/"
    }

    transition {
      days          = 30
      storage_class = "GLACIER"
    }

    expiration {
      days = 365
    }
  }
}

# ---------------------------------------------------------------------------
# Media Assets Bucket — face profile images, recognition thumbnails
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "media" {
  bucket = var.media_bucket_name

  tags = { Name = var.media_bucket_name, Purpose = "media-assets" }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "expire-recognition-thumbnails"
    status = "Enabled"

    filter {
      prefix = "recognition-events/"
    }

    expiration {
      days = 90
    }
  }
}
