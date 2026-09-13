# Tapo camera gateway (go2rtc)

Browsers cannot play Tapo RTSP directly. This service restreams:

`rtsp://USER:PASS@CAMERA_IP:554/stream1` → JPEG / WebRTC on `127.0.0.1:1990`

The detector reads `http://127.0.0.1:1990/api/frame.jpeg?src=cam01`.
The dashboard plays the same `cam01` source over WebRTC.

## Config

```bash
cd gateway
cp go2rtc.yaml.example go2rtc.yaml
```

Put the real Tapo RTSP URL in `go2rtc.yaml` (that file is gitignored).

## Start

Download `go2rtc.exe` from the [go2rtc releases](https://github.com/AlexxIT/go2rtc/releases) into this folder (do not commit the binary).

```bash
cd gateway
./go2rtc.exe -config go2rtc.yaml
```

If an old process is still bound to the ports:

```bash
taskkill //IM go2rtc.exe //F
```

Or with Docker Desktop: `docker compose up -d`
(compose maps `1984` / `8554`; the yaml used on Windows listens on `1990` / `8560` / `8561`).

## Tapo app

1. Camera online on the LAN
2. **Camera Settings → Advanced → Camera Account** — RTSP username/password (not the Tapo cloud login)
3. Paths: `/stream1` (HD), `/stream2` (SD)

Keep go2rtc running while the dashboard and detector are in use.
