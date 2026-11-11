# Tapo camera gateway (go2rtc)

Browsers cannot play Tapo RTSP directly. This gateway restreams:

`rtsp://…@CAMERA_IP:554/stream1` → `http://127.0.0.1:1990/api/stream.mp4?src=cam01`

For lower latency, use go2rtc WebRTC (`/webrtc.html?src=cam01`).

## Tapo C545D dual lens

| go2rtc name | Camera | RTSP path | Meaning |
|---|---|---|---|
| `cam01` | First (`TAPO_HOST`) | `/stream1` | Wide-angle lens (HD) — YOLO + ByteTrack + motion |
| `cam02` | First (`TAPO_HOST`) | `/stream6` | Telephoto lens — independent YOLO pipeline |
| `cam03` | Second (`TAPO2_HOST`) | `/stream1` | Paco wide-angle lens |
| `cam04` | Second (`TAPO2_HOST`) | `/stream6` | Paco telephoto lens |
| — | — | `/stream2` | SD of a wide-angle lens (not a second POV) |

The detector grabs each stream as a JPEG from go2rtc so each Tapo is opened only
by go2rtc. Opening a camera’s RTSP directly from detector workers starves
`/stream6` and blanks that lens in the browser.

## Credentials

Copy `.env.example` to `.env` and set:

- `TAPO_RTSP_USER` / `TAPO_RTSP_PASS` — first camera, Tapo app → Advanced → Camera Account
- `TAPO_HOST` — first camera LAN IP (Device Info)
- `TAPO2_RTSP_USER` / `TAPO2_RTSP_PASS` / `TAPO2_HOST` — second camera. Its Camera Account is separate. `start.sh` warns and still starts the first camera when these are empty.

Do not put secrets in `go2rtc.yaml`.

## Start

```bash
cd gateway
./start.sh
```

`start.sh` loads `.env` then runs go2rtc. Running `./go2rtc.exe` alone leaves `${TAPO_HOST}` unexpanded and the dashboard stays blank.

Or follow `command.txt`. With Docker Desktop: `docker compose up -d`

## UI

Laravel cameras should point at go2rtc, not at the Tapo RTSP URL:

- CAM-01 → `http://127.0.0.1:1990/api/stream.mp4?src=cam01`
- CAM-02 → `http://127.0.0.1:1990/api/stream.mp4?src=cam02`
- CAM-03 → `http://127.0.0.1:1990/api/stream.mp4?src=cam03`
- CAM-04 → `http://127.0.0.1:1990/api/stream.mp4?src=cam04`

Keep go2rtc running while using the dashboard.
