output "video_bucket_name" {
  value = aws_s3_bucket.video.bucket
}

output "video_bucket_arn" {
  value = aws_s3_bucket.video.arn
}

output "media_bucket_name" {
  value = aws_s3_bucket.media.bucket
}

output "media_bucket_arn" {
  value = aws_s3_bucket.media.arn
}
