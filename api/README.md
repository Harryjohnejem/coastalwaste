# Coastal waste API (Laravel)

REST API for the React dashboard and the Python detector.

## Quick start

```bash
cd api
cp .env.example .env
php artisan key:generate
php artisan migrate --seed
php artisan serve
```

Default database in `.env.example` is MySQL (`coastal_waste_monitoring_reporting_db`).
API base URL: `http://localhost:8000/api`

Endpoint catalog: `docs/api/endpoints.md`. Tests: `php artisan test`.

## Login (Sanctum)

The seeded admin is created by `database/seeders/AdminUserSeeder.php`.
Use that email/password with `POST /api/login`.

```bash
curl -X POST http://localhost:8000/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<seeded-admin-email>","password":"<seeded-password>"}'
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
| `GET` | `/stats/trends` | Detection trends |
| `GET` | `/settings` | System settings |
| `PUT` | `/settings` | Save settings |
| `POST` | `/reports` | File cleanup report |
| `GET` | `/quotas` | Waste quotas |
| `GET` | `/notifications` | Operator notifications |
| `GET` | `/waste-catalog` | Categories + classifications |

`POST /login` and `POST /detections/live` are public (detector uses `X-Detector-Key`). All other routes require `auth:sanctum`.

Set `DETECTOR_KEY` in `.env` (default `tidalwatch-detector-local`) to match `detector/.env`.

## Frontend wiring

In `web/.env`:

```
VITE_API_URL=http://localhost:8000/api
```

Sign in at `/login` with the seeded admin (see `AdminUserSeeder`).

## CORS

`config/cors.php` allows `http://localhost:5173` and `http://127.0.0.1:5173` for the Vite dev server.

## Database

Configured for MySQL (`DB_DATABASE=coastal_waste_monitoring_reporting_db`).
Seeders load the admin user, cameras, waste catalog, notifications, and quotas.
Migrations and seeders stay in `database/` (Laravel), not at the repo root.

## Camera stream test

`POST /cameras/{id}/test` probes the configured URL:

- **RTSP** — TCP connect to host:port (554 default)
- **HTTP / HLS / MJPEG** — HTTP HEAD/GET with latency timing

Browsers still need an HLS/MJPEG gateway for RTSP cameras; the API only validates reachability.
