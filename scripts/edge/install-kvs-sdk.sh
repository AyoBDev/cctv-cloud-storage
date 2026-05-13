#!/bin/bash
# ============================================================================
# CCTV Cloud Storage — KVS Producer SDK Installer
# One-command setup for Raspberry Pi (Debian/Ubuntu-based).
# ============================================================================

set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
step() { echo -e "${CYAN}[STEP]${NC} $1"; }

INSTALL_DIR="${INSTALL_DIR:-$HOME/amazon-kinesis-video-streams-producer-sdk-cpp}"

# --- Step 1: System Dependencies ---
step "Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  cmake g++ git libssl-dev libcurl4-openssl-dev \
  liblog4cplus-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-base-apps gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly gstreamer1.0-tools \
  jq

# --- Step 2: Clone SDK ---
if [[ -d "$INSTALL_DIR" ]]; then
  info "KVS SDK already cloned at $INSTALL_DIR"
else
  step "Cloning KVS Producer SDK..."
  git clone https://github.com/awslabs/amazon-kinesis-video-streams-producer-sdk-cpp.git "$INSTALL_DIR"
fi

# --- Step 3: Build ---
step "Building KVS SDK (this may take 5-15 minutes on a Pi)..."
mkdir -p "$INSTALL_DIR/build"
cd "$INSTALL_DIR/build"
cmake .. -DBUILD_GSTREAMER_PLUGIN=ON -DBUILD_DEPENDENCIES=ON -DBUILD_SAMPLES=ON
make -j"$(nproc)"

# --- Step 4: Verify ---
if [[ -f "$INSTALL_DIR/build/kvs_gstreamer_sample" ]]; then
  info "Build successful!"
else
  echo "ERROR: Build failed — kvs_gstreamer_sample not found"
  exit 1
fi

# --- Step 5: Disable IPv6 (common Pi issue) ---
step "Disabling IPv6 (prevents KVS timeout issues)..."
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1 2>/dev/null || true
sudo sysctl -w net.ipv6.conf.default.disable_ipv6=1 2>/dev/null || true

if ! grep -q "net.ipv6.conf.all.disable_ipv6" /etc/sysctl.conf 2>/dev/null; then
  echo "net.ipv6.conf.all.disable_ipv6 = 1" | sudo tee -a /etc/sysctl.conf >/dev/null
  echo "net.ipv6.conf.default.disable_ipv6 = 1" | sudo tee -a /etc/sysctl.conf >/dev/null
fi

# --- Step 6: Create directories ---
mkdir -p "$HOME/certs" "$HOME/logs/cameras"

# --- Done ---
echo ""
echo "=========================================="
echo -e "${GREEN}KVS Producer SDK installed successfully!${NC}"
echo "=========================================="
echo "  Location: $INSTALL_DIR/build"
echo "  Binary:   $INSTALL_DIR/build/kvs_gstreamer_sample"
echo ""
echo "Next steps:"
echo "  1. Register a camera via the API"
echo "  2. Run: ./setup-camera.sh --token <TOKEN> --camera-id <ID> --alias front-door"
echo "  3. Add RTSP_URL to ~/certs/front-door/camera.env"
echo "  4. Run: ./start-cameras.sh start"
echo "=========================================="
