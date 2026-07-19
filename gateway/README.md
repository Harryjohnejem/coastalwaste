# Tapo camera gateway (go2rtc)

Browsers cannot play Tapo RTSP directly. This gateway restreams:

`rtsp://…@192.168.1.61:554/stream1` → `http://127.0.0.1:1984/api/stream.m3u8?src=cam01`

For even lower latency later, switch the UI to go2rtc WebRTC
(`http://127.0.0.1:1984/stream.html?src=cam01`) — typically under 1s.

## Start

```bash
cd gateway
./go2rtc.exe -config go2rtc.yaml
```

Or with Docker Desktop running: `docker compose up -d`

## Tapo app requirements

1. Camera online on LAN (`192.168.1.61`)
2. **Camera Settings → Advanced → Camera Account** — create RTSP username/password  
   (these are not your Tapo cloud login)
3. RTSP paths: `/stream1` (HD), `/stream2` (SD)

## UI

CAM-01 in the API uses the HLS URL above. Keep go2rtc running while using the dashboard.
