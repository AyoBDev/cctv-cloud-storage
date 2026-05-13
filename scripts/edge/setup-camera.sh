#!/bin/bash
# ============================================================================
# CCTV Cloud Storage — Camera Setup Script
# Downloads credentials from the API and configures a camera for streaming.
# Run this ONCE per camera after registering it via the API.
# ============================================================================

set -euo pipefail

# --- Configuration ---
API_URL="${API_URL:-http://localhost:3000}"
KVS_SDK_PATH="${KVS_SDK_PATH:-$HOME/amazon-kinesis-video-streams-producer-sdk-cpp/build}"
CERTS_BASE="${CERTS_BASE:-$HOME/certs}"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- Usage ---
usage() {
  echo "Usage: $0 --token <ORG_ADMIN_TOKEN> --camera-id <CAMERA_ID> [--alias <FRIENDLY_NAME>]"
  echo ""
  echo "Options:"
  echo "  --token       Org admin access token (Bearer token from login)"
  echo "  --camera-id   Camera UUID (from POST /api/v1/cameras response)"
  echo "  --alias       Friendly name for local directory (default: camera ID)"
  echo ""
  echo "Environment:"
  echo "  API_URL       API base URL (default: http://localhost:3000)"
  echo "  KVS_SDK_PATH  Path to KVS SDK build dir (default: ~/amazon-kinesis-video-streams-producer-sdk-cpp/build)"
  echo "  CERTS_BASE    Base directory for certs (default: ~/certs)"
  exit 1
}

# --- Parse Arguments ---
TOKEN=""
CAMERA_ID=""
ALIAS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --token) TOKEN="$2"; shift 2 ;;
    --camera-id) CAMERA_ID="$2"; shift 2 ;;
    --alias) ALIAS="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) error "Unknown option: $1" ;;
  esac
done

[[ -z "$TOKEN" ]] && error "Missing --token"
[[ -z "$CAMERA_ID" ]] && error "Missing --camera-id"
[[ -z "$ALIAS" ]] && ALIAS="$CAMERA_ID"

# --- Check Dependencies ---
command -v curl >/dev/null 2>&1 || error "curl is required"
command -v jq >/dev/null 2>&1 || error "jq is required (sudo apt-get install jq)"

# --- Download Credentials ---
info "Downloading credentials for camera: $CAMERA_ID"

CREDS_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$API_URL/api/v1/cameras/$CAMERA_ID/credentials")

HTTP_CODE=$(echo "$CREDS_RESPONSE" | tail -1)
CREDS_JSON=$(echo "$CREDS_RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" == "409" ]]; then
  error "Credentials already issued for this camera. Deactivate and re-register to get new credentials."
fi

if [[ "$HTTP_CODE" != "200" ]]; then
  error "Failed to download credentials (HTTP $HTTP_CODE): $CREDS_JSON"
fi

info "Credentials downloaded successfully"

# --- Save Certificates ---
CERT_DIR="$CERTS_BASE/$ALIAS"
mkdir -p "$CERT_DIR"

echo "$CREDS_JSON" | jq -r '.device_cert' > "$CERT_DIR/device.crt"
echo "$CREDS_JSON" | jq -r '.private_key' > "$CERT_DIR/private.key"
chmod 600 "$CERT_DIR/private.key"

ROOT_CA_URL=$(echo "$CREDS_JSON" | jq -r '.root_ca_url')
curl -s -o "$CERT_DIR/root-ca.pem" "$ROOT_CA_URL"

info "Certificates saved to: $CERT_DIR"

# --- Extract Connection Info ---
KVS_STREAM_NAME=$(echo "$CREDS_JSON" | jq -r '.kvs_stream_name')
IOT_ENDPOINT=$(echo "$CREDS_JSON" | jq -r '.iot_credential_endpoint')
ROLE_ALIAS=$(echo "$CREDS_JSON" | jq -r '.role_alias')
REGION=$(echo "$CREDS_JSON" | jq -r '.region')

# --- Write Environment File ---
ENV_FILE="$CERT_DIR/camera.env"
cat > "$ENV_FILE" <<EOF
# Camera: $ALIAS ($CAMERA_ID)
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
AWS_DEFAULT_REGION=$REGION
CERT_PATH=$CERT_DIR/device.crt
PRIVATE_KEY_PATH=$CERT_DIR/private.key
CA_CERT_PATH=$CERT_DIR/root-ca.pem
ROLE_ALIAS=$ROLE_ALIAS
IOT_GET_CREDENTIAL_ENDPOINT=$IOT_ENDPOINT
KVS_STREAM_NAME=$KVS_STREAM_NAME
KVS_SDK_PATH=$KVS_SDK_PATH
EOF

info "Environment file written to: $ENV_FILE"

# --- Write Camera Config Entry ---
CONFIG_FILE="$CERTS_BASE/cameras.conf"
if ! grep -q "^$ALIAS|" "$CONFIG_FILE" 2>/dev/null; then
  echo "$ALIAS|$KVS_STREAM_NAME|$CERT_DIR" >> "$CONFIG_FILE"
  info "Added to cameras.conf"
fi

# --- Summary ---
echo ""
echo "=========================================="
echo -e "${GREEN}Camera setup complete!${NC}"
echo "=========================================="
echo "  Stream name: $KVS_STREAM_NAME"
echo "  Certs dir:   $CERT_DIR"
echo "  Env file:    $ENV_FILE"
echo ""
echo "To start streaming manually:"
echo "  source $ENV_FILE"
echo "  cd $KVS_SDK_PATH"
echo "  ./kvs_gstreamer_sample \$KVS_STREAM_NAME <RTSP_URL>"
echo ""
echo "Or use start-cameras.sh for multi-camera management."
echo "=========================================="
