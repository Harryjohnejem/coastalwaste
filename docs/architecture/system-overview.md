# System architecture

Computer Vision-Based Coastal Waste Monitoring and Reporting System (web + on-LAN cameras).

## Context

Barangay operators watch Paco Beach cameras, review YOLO waste detections, watch the cleanup threshold, and file cleanup reports. There is no mobile or desktop client — only the Vite dashboard.

## Services and ports

```
                    ┌─────────────────┐
   Tapo RTSP        │  gateway        │  :1990 JPEG / WebRTC
   192.168.x.x ───► │  go2rtc         │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼                             ▼
     ┌────────────────┐            ┌────────────────┐
     │ web            │            │ detector       │
     │ React + Vite   │            │ YOLO-World     │
     │ :5173          │            │ :8092          │
     └────────┬───────┘            └────────┬───────┘
              │  Sanctum REST               │ X-Detector-Key
              ▼                             ▼
                    ┌────────────────┐
                    │ api            │  :8000
                    │ Laravel        │
                    └────────┬───────┘
                             ▼
                    ┌────────────────┐
                    │ MySQL          │
                    │ coastal_waste_ │
                    │ monitoring_…   │
                    └────────────────┘
```

| Service | Folder | Why it exists |
|---------|--------|----------------|
| Gateway | `gateway/` | Browsers cannot play Tapo RTSP. go2rtc publishes `cam01`. |
| API | `api/` | Auth, persistence, stats, cleanup threshold, detector ingest. |
| Detector | `detector/` | Open-vocab YOLO on JPEG frames; posts boxes + log hits. |
| Web | `web/` | Operator UI (four modules). |

## Request paths

1. **Login** — `web` → `POST /api/login` → Sanctum token.
2. **Live video** — `web` StreamPlayer → go2rtc WebRTC `src=cam01`.
3. **Live boxes** — detector grabs ` /api/frame.jpeg?src=cam01` → YOLO → `POST /api/detections/live`.
4. **Dashboard data** — `web` Axios modules in `web/src/api/` → Sanctum routes.
5. **Manual detection** — Waste Detections module → `POST /api/detections`.

## Why this is not `frontend/` + `backend/` only

The sample tree in the course guide is for a two-tier web app. This capstone also has a **stream gateway** and a **Python CV worker**. Renaming Laravel to `backend/src/controllers` would break Composer autoload and `artisan`.

## Related diagrams

- Logical ERD: `docs/diagrams/logical-erd.mmd`
- Class diagram: `docs/diagrams/class-diagram.mmd`
- Figure captions for the manuscript: `docs/diagrams/figure-captions.txt`
