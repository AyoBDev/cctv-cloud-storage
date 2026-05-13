#!/bin/bash
# ============================================================================
# CCTV Cloud Storage — Multi-Camera Launcher
# Reads cameras.conf and starts a KVS producer for each configured camera.
# Supports start, stop, status, and restart operations.
# ============================================================================

set -euo pipefail

CERTS_BASE="${CERTS_BASE:-$HOME/certs}"
CONFIG_FILE="${CONFIG_FILE:-$CERTS_BASE/cameras.conf}"
PID_DIR="${PID_DIR:-/tmp/cctv-cameras}"
LOG_DIR="${LOG_DIR:-$HOME/logs/cameras}"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Usage ---
usage() {
  echo "Usage: $0 <command> [camera_alias]"
  echo ""
  echo "Commands:"
  echo "  start   [alias]   Start all cameras (or a specific one)"
  echo "  stop    [alias]   Stop all cameras (or a specific one)"
  echo "  restart [alias]   Restart all cameras (or a specific one)"
  echo "  status            Show status of all cameras"
  echo "  logs    <alias>   Tail logs for a specific camera"
  echo ""
  echo "Config file: $CONFIG_FILE"
  echo "Format: alias|kvs_stream_name|cert_dir"
  echo ""
  echo "Each camera also needs an RTSP URL. Set it in the env file:"
  echo "  echo 'RTSP_URL=rtsp://user:pass@ip:554/stream' >> ~/certs/<alias>/camera.env"
  exit 1
}

# --- Ensure directories exist ---
mkdir -p "$PID_DIR" "$LOG_DIR"

# --- Helpers ---
get_pid_file() { echo "$PID_DIR/$1.pid"; }
get_log_file() { echo "$LOG_DIR/$1.log"; }

is_running() {
  local pid_file
  pid_file=$(get_pid_file "$1")
  if [[ -f "$pid_file" ]]; then
    local pid
    pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    rm -f "$pid_file"
  fi
  return 1
}

# --- Start a single camera ---
start_camera() {
  local alias="$1"
  local stream_name="$2"
  local cert_dir="$3"

  if is_running "$alias"; then
    echo -e "  ${YELLOW}[SKIP]${NC} $alias — already running (PID $(cat "$(get_pid_file "$alias")"))"
    return 0
  fi

  local env_file="$cert_dir/camera.env"
  if [[ ! -f "$env_file" ]]; then
    echo -e "  ${RED}[ERROR]${NC} $alias — no env file at $env_file"
    return 1
  fi

  # Source the env file
  set -a
  # shellcheck source=/dev/null
  source "$env_file"
  set +a

  # Check for RTSP URL
  if [[ -z "${RTSP_URL:-}" ]]; then
    echo -e "  ${RED}[ERROR]${NC} $alias — RTSP_URL not set in $env_file"
    echo "         Add: RTSP_URL=rtsp://user:pass@ip:554/stream"
    return 1
  fi

  local kvs_sdk_path="${KVS_SDK_PATH:-$HOME/amazon-kinesis-video-streams-producer-sdk-cpp/build}"
  local producer="$kvs_sdk_path/kvs_gstreamer_sample"

  if [[ ! -x "$producer" ]]; then
    echo -e "  ${RED}[ERROR]${NC} $alias — producer not found at $producer"
    return 1
  fi

  local log_file
  log_file=$(get_log_file "$alias")
  local pid_file
  pid_file=$(get_pid_file "$alias")

  # Start producer in background
  nohup "$producer" "$stream_name" "$RTSP_URL" > "$log_file" 2>&1 &
  local pid=$!
  echo "$pid" > "$pid_file"

  echo -e "  ${GREEN}[START]${NC} $alias → $stream_name (PID $pid)"
}

# --- Stop a single camera ---
stop_camera() {
  local alias="$1"
  local pid_file
  pid_file=$(get_pid_file "$alias")

  if ! is_running "$alias"; then
    echo -e "  ${YELLOW}[SKIP]${NC} $alias — not running"
    return 0
  fi

  local pid
  pid=$(cat "$pid_file")
  kill "$pid" 2>/dev/null || true
  rm -f "$pid_file"

  echo -e "  ${RED}[STOP]${NC} $alias (PID $pid)"
}

# --- Read cameras from config ---
read_cameras() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo -e "${RED}[ERROR]${NC} Config file not found: $CONFIG_FILE"
    echo "Run setup-camera.sh first to register cameras."
    exit 1
  fi

  grep -v '^#' "$CONFIG_FILE" | grep -v '^$'
}

# --- Commands ---
cmd_start() {
  local target="${1:-}"
  echo -e "${CYAN}Starting cameras...${NC}"

  while IFS='|' read -r alias stream_name cert_dir; do
    if [[ -n "$target" && "$alias" != "$target" ]]; then
      continue
    fi
    start_camera "$alias" "$stream_name" "$cert_dir"
  done < <(read_cameras)

  echo ""
  echo -e "${GREEN}Done.${NC} Use '$0 status' to check."
}

cmd_stop() {
  local target="${1:-}"
  echo -e "${CYAN}Stopping cameras...${NC}"

  while IFS='|' read -r alias _ _; do
    if [[ -n "$target" && "$alias" != "$target" ]]; then
      continue
    fi
    stop_camera "$alias"
  done < <(read_cameras)
}

cmd_restart() {
  local target="${1:-}"
  cmd_stop "$target"
  sleep 2
  cmd_start "$target"
}

cmd_status() {
  echo -e "${CYAN}Camera Status${NC}"
  echo "─────────────────────────────────────────────────────"
  printf "  %-20s %-30s %s\n" "ALIAS" "STREAM" "STATUS"
  echo "─────────────────────────────────────────────────────"

  while IFS='|' read -r alias stream_name _; do
    if is_running "$alias"; then
      local pid
      pid=$(cat "$(get_pid_file "$alias")")
      printf "  %-20s %-30s ${GREEN}%s${NC}\n" "$alias" "$stream_name" "RUNNING (PID $pid)"
    else
      printf "  %-20s %-30s ${RED}%s${NC}\n" "$alias" "$stream_name" "STOPPED"
    fi
  done < <(read_cameras)

  echo "─────────────────────────────────────────────────────"
}

cmd_logs() {
  local alias="${1:-}"
  if [[ -z "$alias" ]]; then
    echo "Usage: $0 logs <alias>"
    exit 1
  fi

  local log_file
  log_file=$(get_log_file "$alias")

  if [[ ! -f "$log_file" ]]; then
    echo "No log file for camera: $alias"
    exit 1
  fi

  tail -f "$log_file"
}

# --- Main ---
COMMAND="${1:-}"
TARGET="${2:-}"

case "$COMMAND" in
  start)   cmd_start "$TARGET" ;;
  stop)    cmd_stop "$TARGET" ;;
  restart) cmd_restart "$TARGET" ;;
  status)  cmd_status ;;
  logs)    cmd_logs "$TARGET" ;;
  *)       usage ;;
esac
