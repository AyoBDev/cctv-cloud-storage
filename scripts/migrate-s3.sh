#!/usr/bin/env bash
set -euo pipefail

SOURCE_PROFILE="${1:-default}"
DEST_PROFILE="${2:-olympusvision}"
SOURCE_REGION="eu-west-2"
DEST_REGION="eu-west-1"

echo "=== Syncing video bucket ==="
aws s3 sync \
  "s3://cctv-staging-video" \
  "s3://cctv-staging-video" \
  --source-region "$SOURCE_REGION" \
  --region "$DEST_REGION" \
  --profile "$DEST_PROFILE" \
  --copy-props none

echo ""
echo "=== Syncing media bucket ==="
aws s3 sync \
  "s3://cctv-staging-media" \
  "s3://cctv-staging-media" \
  --source-region "$SOURCE_REGION" \
  --region "$DEST_REGION" \
  --profile "$DEST_PROFILE" \
  --copy-props none

echo ""
echo "Done. Verify with:"
echo "  aws s3 ls s3://cctv-staging-video --recursive --summarize --profile $DEST_PROFILE --region $DEST_REGION"
echo "  aws s3 ls s3://cctv-staging-media --recursive --summarize --profile $DEST_PROFILE --region $DEST_REGION"
