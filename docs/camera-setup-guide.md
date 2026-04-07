# Camera Setup Guide

How to connect an RTSP IP camera to the CCTV Cloud Storage platform via a Raspberry Pi and AWS Kinesis Video Streams.

## Prerequisites

- Raspberry Pi 3B+ or later (Pi 4 recommended for multiple cameras)
- RTSP-capable IP camera on the same local network as the Pi
- Camera's RTSP URL verified (test with VLC: Media > Open Network Stream)
- An org_admin account on the CCTV Cloud Storage platform

## Phase 1: Prepare the Raspberry Pi

### Install Dependencies

```bash
sudo apt-get update
sudo apt-get install -y cmake g++ libssl-dev libcurl4-openssl-dev \
  liblog4cplus-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-base-apps gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly gstreamer1.0-tools
```

### Build the KVS Producer SDK

```bash
git clone https://github.com/awslabs/amazon-kinesis-video-streams-producer-sdk-cpp.git
cd amazon-kinesis-video-streams-producer-sdk-cpp
mkdir build && cd build
cmake .. -DBUILD_GSTREAMER_PLUGIN=ON -DBUILD_DEPENDENCIES=ON -DBUILD_SAMPLES=ON
make -j4
```

This takes several minutes on a Pi. Verify the build produced `kvs_gstreamer_sample` and `libgstkvssink.so`:

```bash
ls kvs_gstreamer_sample libgstkvssink.so
```

### Disable IPv6 (if needed)

If your network doesn't have working IPv6, the SDK will try IPv6 first and time out. Disable it:

```bash
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1
sudo sysctl -w net.ipv6.conf.default.disable_ipv6=1

# Make permanent
echo "net.ipv6.conf.all.disable_ipv6 = 1" | sudo tee -a /etc/sysctl.conf
echo "net.ipv6.conf.default.disable_ipv6 = 1" | sudo tee -a /etc/sysctl.conf
```

## Phase 2: Register the Camera

### Step 1 — Create the Camera via API

As an org_admin, register the camera:

```bash
curl -X POST https://your-api-url/api/v1/cameras \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Front Door Camera",
    "location": "Main Entrance",
    "timezone": "Europe/London",
    "rtsp_url": "rtsp://user:pass@192.168.1.100:554/stream"
  }'
```

Note the `id` from the response — you'll need it in the next step.

### Step 2 — Download Credentials

Download the IoT credentials for this camera:

```bash
curl -X GET https://your-api-url/api/v1/cameras/CAMERA_ID/credentials \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -o credentials.json
```

The response contains:
- `device_cert` — the device certificate PEM
- `private_key` — the private key PEM
- `root_ca_url` — URL to download the Amazon Root CA
- `iot_credential_endpoint` — the IoT credential provider endpoint
- `kvs_stream_name` — the KVS stream name for this camera
- `role_alias` — the IoT role alias
- `region` — the AWS region

**This is a one-time download.** The credentials cannot be downloaded again. Store them securely.

### Step 3 — Save Credentials to Files

On the Pi, create a `certs` directory and save the credentials:

```bash
mkdir -p ~/certs

# Extract and save from credentials.json (use jq or manually copy)
jq -r '.device_cert' credentials.json > ~/certs/device.crt
jq -r '.private_key' credentials.json > ~/certs/private.key

# Download the Root CA
curl -o ~/certs/root-ca.pem $(jq -r '.root_ca_url' credentials.json)
```

## Phase 3: Start Streaming

### Set Environment Variables

```bash
export AWS_DEFAULT_REGION=eu-west-2
export CERT_PATH=$HOME/certs/device.crt
export PRIVATE_KEY_PATH=$HOME/certs/private.key
export CA_CERT_PATH=$HOME/certs/root-ca.pem
export ROLE_ALIAS=camera-iot-role-alias
export IOT_GET_CREDENTIAL_ENDPOINT=<iot_credential_endpoint from credentials.json>
```

### Run the Producer

```bash
cd ~/amazon-kinesis-video-streams-producer-sdk-cpp/build
./kvs_gstreamer_sample <kvs_stream_name> <rtsp_url>
```

Replace `<kvs_stream_name>` and `<rtsp_url>` with values from the camera registration.

### Verify

1. Open the AWS Console > Kinesis Video Streams > your stream
2. Click **Media playback** to see the live feed
3. Check the **Monitoring** tab for PutMedia activity
4. Call `GET /api/v1/cameras/CAMERA_ID` to verify status is `online`

## Multi-Stream Setup

To stream multiple cameras from one device, run one producer process per camera. Each camera has its own IoT Thing, certificate, and KVS stream.

### Register All Cameras

Register each camera via the API and download credentials for each one:

```bash
# For each camera, save certs to separate directories
mkdir -p ~/certs/camera1 ~/certs/camera2

# Download and extract credentials for each camera
# ... (repeat Phase 2, Steps 2-3 for each camera)
```

### Run Multiple Producers

Create a script `~/start-cameras.sh`:

```bash
#!/bin/bash

# Camera 1
(
  export AWS_DEFAULT_REGION=eu-west-2
  export CERT_PATH=$HOME/certs/camera1/device.crt
  export PRIVATE_KEY_PATH=$HOME/certs/camera1/private.key
  export CA_CERT_PATH=$HOME/certs/camera1/root-ca.pem
  export ROLE_ALIAS=camera-iot-role-alias
  export IOT_GET_CREDENTIAL_ENDPOINT=<endpoint>
  cd ~/amazon-kinesis-video-streams-producer-sdk-cpp/build
  ./kvs_gstreamer_sample <stream-name-1> <rtsp-url-1> &
)

# Camera 2
(
  export AWS_DEFAULT_REGION=eu-west-2
  export CERT_PATH=$HOME/certs/camera2/device.crt
  export PRIVATE_KEY_PATH=$HOME/certs/camera2/private.key
  export CA_CERT_PATH=$HOME/certs/camera2/root-ca.pem
  export ROLE_ALIAS=camera-iot-role-alias
  export IOT_GET_CREDENTIAL_ENDPOINT=<endpoint>
  cd ~/amazon-kinesis-video-streams-producer-sdk-cpp/build
  ./kvs_gstreamer_sample <stream-name-2> <rtsp-url-2> &
)

echo "All cameras started. Use 'jobs' to check status."
wait
```

```bash
chmod +x ~/start-cameras.sh
./start-cameras.sh
```

### Resource Guidelines

| Device | Max Concurrent Streams |
|--------|----------------------|
| Raspberry Pi 3B+ | 2 |
| Raspberry Pi 4 (4GB) | 4-6 |
| Mini PC / NUC | 8+ |

**Fault isolation:** Each process is independent. If one camera's RTSP feed drops, only that process stops — the others keep streaming.

**For 10+ cameras** on a single device, consider using the `libgstkvssink.so` GStreamer plugin in a custom pipeline for reduced memory overhead. See the [KVS Producer SDK documentation](https://github.com/awslabs/amazon-kinesis-video-streams-producer-sdk-cpp) for details.

## Troubleshooting

### Stream not appearing in KVS
- Verify all environment variables are set correctly
- Confirm the stream name matches exactly (it's `{orgId}-{cameraId}`)
- Check that the credential endpoint matches your region

### Video not playing in browser
- Check the Monitoring tab for PutMedia activity — if present, the stream works
- Try Chrome (best codec support for KVS HLS)

### Authentication errors
- Ensure certificate file paths are absolute (not relative)
- Verify the credential endpoint is correct for your region
- Re-check that credentials were downloaded before they expire

### `Timeout was reached` / `Unable to create IoT Credential provider`
- This is usually IPv6 on the Pi interfering. See the "Disable IPv6" section above.
- Test manually:
  ```bash
  curl -v https://<endpoint>.credentials.iot.eu-west-2.amazonaws.com/role-aliases/<alias>/credentials \
    --cert ~/certs/device.crt \
    --key ~/certs/private.key \
    --cacert ~/certs/root-ca.pem
  ```
  If curl returns HTTP 200 but the SDK times out, IPv6 is the culprit.
