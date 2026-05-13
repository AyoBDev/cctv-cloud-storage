# Edge Device Scripts

Scripts for setting up Raspberry Pi (or any Linux device) to stream RTSP cameras to AWS KVS.

## Quick Start

```bash
# 1. Install KVS SDK (one-time, ~10 min on Pi 4)
./install-kvs-sdk.sh

# 2. Register camera in API and download credentials
./setup-camera.sh --token <ORG_ADMIN_TOKEN> --camera-id <UUID> --alias front-door

# 3. Add RTSP URL to the camera config
echo 'RTSP_URL=rtsp://admin:pass@192.168.1.100:554/stream' >> ~/certs/front-door/camera.env

# 4. Start streaming
./start-cameras.sh start
```

## Scripts

| Script | Purpose |
|--------|---------|
| `install-kvs-sdk.sh` | Install dependencies + build KVS Producer SDK |
| `setup-camera.sh` | Download credentials from API, save certs, create env file |
| `start-cameras.sh` | Multi-camera process manager (start/stop/restart/status/logs) |

## Multi-Camera Workflow

```bash
# Register 3 cameras
./setup-camera.sh --token $TOKEN --camera-id $CAM1_ID --alias front-door
./setup-camera.sh --token $TOKEN --camera-id $CAM2_ID --alias parking-lot
./setup-camera.sh --token $TOKEN --camera-id $CAM3_ID --alias back-entrance

# Add RTSP URLs
echo 'RTSP_URL=rtsp://admin:pass@192.168.1.100:554/stream' >> ~/certs/front-door/camera.env
echo 'RTSP_URL=rtsp://admin:pass@192.168.1.101:554/stream' >> ~/certs/parking-lot/camera.env
echo 'RTSP_URL=rtsp://admin:pass@192.168.1.102:554/stream' >> ~/certs/back-entrance/camera.env

# Start all cameras
./start-cameras.sh start

# Check status
./start-cameras.sh status

# View logs for one camera
./start-cameras.sh logs front-door

# Restart a specific camera
./start-cameras.sh restart parking-lot

# Stop everything
./start-cameras.sh stop
```

## Auto-Start on Boot

Add to `/etc/rc.local` or create a systemd service:

```bash
# /etc/systemd/system/cctv-cameras.service
[Unit]
Description=CCTV Camera Streaming
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=pi
ExecStart=/home/pi/scripts/start-cameras.sh start
ExecStop=/home/pi/scripts/start-cameras.sh stop
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable cctv-cameras
sudo systemctl start cctv-cameras
```

## File Layout After Setup

```
~/certs/
├── cameras.conf              # Auto-generated registry of all cameras
├── front-door/
│   ├── camera.env            # Environment variables for this camera
│   ├── device.crt            # IoT device certificate
│   ├── private.key           # Private key (600 permissions)
│   └── root-ca.pem           # Amazon Root CA
├── parking-lot/
│   ├── camera.env
│   ├── device.crt
│   ├── private.key
│   └── root-ca.pem
~/logs/cameras/
├── front-door.log
├── parking-lot.log
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://localhost:3000` | API base URL for setup-camera.sh |
| `KVS_SDK_PATH` | `~/amazon-kinesis-video-streams-producer-sdk-cpp/build` | KVS SDK build dir |
| `CERTS_BASE` | `~/certs` | Base directory for certificates |
| `PID_DIR` | `/tmp/cctv-cameras` | PID files for running processes |
| `LOG_DIR` | `~/logs/cameras` | Log output directory |
