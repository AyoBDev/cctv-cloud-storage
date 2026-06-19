#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# migrate-s3.sh
#
# Syncs S3 video and media buckets from staging to the new account.
#
# IMPORTANT: For cross-account S3 copy, ensure:
# 1. The source bucket (eu-west-2) allows GetObject/ListBucket for the destination AWS account
# 2. The destination bucket policy allows PutObject from the destination account
# 3. Both buckets are in their respective regions
#
# If cross-account bucket policy is not in place, use a two-step approach:
#   aws s3 sync s3://cctv-staging-video /tmp/s3-video --profile default --region eu-west-2
#   aws s3 sync /tmp/s3-video s3://olympusvision-staging-video --profile olympusvision --region eu-west-1
# ---------------------------------------------------------------------------
set -euo pipefail

SOURCE_PROFILE="${1:-default}"
DEST_PROFILE="${2:-olympusvision}"
SOURCE_REGION="eu-west-2"
DEST_REGION="eu-west-1"

echo "=== Syncing video bucket ==="
aws s3 sync \
  "s3://cctv-staging-video" \
  "s3://olympusvision-staging-video" \
  --source-region "$SOURCE_REGION" \
  --region "$DEST_REGION" \
  --profile "$DEST_PROFILE" \
  --copy-props none

echo ""
echo "=== Syncing media bucket ==="
aws s3 sync \
  "s3://cctv-staging-media" \
  "s3://olympusvision-staging-media" \
  --source-region "$SOURCE_REGION" \
  --region "$DEST_REGION" \
  --profile "$DEST_PROFILE" \
  --copy-props none

echo ""
echo "Done. Verify with:"
echo "  aws s3 ls s3://olympusvision-staging-video --recursive --summarize --profile $DEST_PROFILE --region $DEST_REGION"
echo "  aws s3 ls s3://olympusvision-staging-media --recursive --summarize --profile $DEST_PROFILE --region $DEST_REGION"
