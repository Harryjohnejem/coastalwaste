# REST API

Base URL: `http://localhost:8000/api`  
Auth: Sanctum bearer token, except login and detector ingest.

Implementation: `api/routes/api.php` and `api/app/Http/Controllers/Api/`.

## Public

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/login` | none | `{ email, password }` → `{ token, user }` |
| `POST` | `/detections/live` | `X-Detector-Key` | YOLO overlay boxes + optional log rows |

## Cameras

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cameras` | List (API shape used by the rail) |
| `POST` | `/cameras` | Create (`name` / `camera_name`, `sector`, stream fields) |
| `PUT` | `/cameras/{camera_code}` | Update |
| `DELETE` | `/cameras/{camera_code}` | Delete |
| `POST` | `/cameras/{camera_code}/test` | Probe stream host (`ok`, `latency_ms`) |

Route key is `camera_code` (example: `CAM-01`).

## Detections

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/detections?limit=50` | Recent log (max 200) |
| `POST` | `/detections` | Manual add (`class`, `camera_id`, confidence, count, location) |
| `GET` | `/detections/live?camera_id=CAM-01` | Cached overlay boxes (30 s TTL) |

## Stats, settings, reports

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stats/today` | Dashboard counters |
| `GET` | `/stats/composition?range=24h` | Category mix (`24h` or `30d`) |
| `GET` | `/stats/trends` | Time series for reports |
| `GET` | `/settings` | `system_settings` |
| `PUT` | `/settings` | Save settings |
| `POST` | `/reports` | File a Summary/Detailed report |

## Cleanup threshold, notifications, catalog

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/waste-load` | Cleanup threshold per camera: count, percent, level (normal / warning / full); sends any level-change alert that is due |
| `GET` | `/notifications` | Current user’s alerts |
| `POST` | `/notifications/read-all` | Mark all read |
| `POST` | `/notifications/{id}/read` | Mark one read |
| `GET` | `/waste-catalog` | Categories + classifications |
| `POST` | `/waste-catalog/categories` | Add category |
| `POST` | `/waste-catalog/classifications` | Add type |

## Detector body (`POST /detections/live`)

```json
{
  "camera_id": "CAM-01",
  "boxes": [{ "class": "plastic bottle", "confidence": 0.82, "left": 0.1, "top": 0.2, "width": 0.2, "height": 0.2 }],
  "detections": [{ "class": "plastic bottle", "confidence": 0.82, "count": 1, "sector": "Sector B" }],
  "inference_ms": 40,
  "model": "yolov8s-worldv2.pt"
}
```

Header: `X-Detector-Key: <DETECTOR_KEY>`.
