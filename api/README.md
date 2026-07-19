# TidalWatch API

Laravel REST API for the Coastal Waste Monitoring frontend.

## Quick start

```bash
cd api
cp .env.example .env   # if needed
php artisan key:generate
touch database/database.sqlite   # if missing
php artisan migrate --seed
php artisan serve
```

API base URL: `http://localhost:8000/api`

## Demo login (Sanctum)

| Field | Value |
|-------|--------|
| Email | `operator@tidalwatch.test` |
| Password | `password` |

```bash
curl -X POST http://localhost:8000/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"operator@tidalwatch.test","password":"password"}'
```

Use the returned `token` as `Authorization: Bearer <token>` on all other endpoints.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/login` | Returns `{ token, user }` |
| `GET` | `/cameras` | List cameras |
| `POST` | `/cameras` | Create camera |
| `PUT` | `/cameras/{id}` | Update camera |
| `DELETE` | `/cameras/{id}` | Delete camera |
| `POST` | `/cameras/{id}/test` | `{ ok, latency_ms }` stream probe |
| `GET` | `/detections?limit=50` | Detection log |
| `POST` | `/detections` | Create detection (auth) |
| `GET` | `/detections/live?camera_id=` | Live YOLO overlay boxes |
| `POST` | `/detections/live` | Ingest from Python detector (`X-Detector-Key`) |
| `GET` | `/stats/today` | Dashboard stats |
| `GET` | `/stats/composition?range=24h` | Waste composition |
| `GET` | `/settings` | System settings |
| `PUT` | `/settings` | Save settings |
| `POST` | `/reports` | File cleanup report |

`POST /login` and `POST /detections/live` are public (detector uses `X-Detector-Key`). All other routes require `auth:sanctum`.

Set `DETECTOR_KEY` in `.env` (default `tidalwatch-detector-local`) to match `detector/.env`.

## Frontend wiring

In `web/.env`:

```
VITE_API_URL=http://localhost:8000/api
```

Sign in at `/login` with the demo credentials above, or set `VITE_AUTH_REQUIRED=true` to enforce auth on the dashboard.

## CORS

`config/cors.php` allows `http://localhost:5173` and `http://127.0.0.1:5173` for the Vite dev server.

## Database

Default: SQLite (`database/database.sqlite`). Seeder loads cameras, detections, reports, and default settings matching the UI template.

## Camera stream test

`POST /cameras/{id}/test` probes the configured URL:

- **RTSP** — TCP connect to host:port (554 default)
- **HTTP / HLS / MJPEG** — HTTP HEAD/GET with latency timing

Browsers still need an HLS/MJPEG gateway for RTSP cameras; the API only validates reachability.
