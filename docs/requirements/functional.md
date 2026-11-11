# Functional requirements

Derived from the implemented dashboard modules, Laravel routes, and detector ingest — not from a generic template.

Site: Paco Beach, Barangay Gracia. Users are barangay operators (seeded as `Admin`).

## FR-1 Authentication

- An operator signs in with email and password (`POST /api/login`).
- Laravel Sanctum returns a bearer token.
- The React app stores the token and sends `Authorization: Bearer` on later calls.
- Wrong credentials return a validation error; the token is cleared on HTTP 401.

## FR-2 Live monitor

- The operator sees the selected Tapo camera in the viewport.
- go2rtc restreams RTSP as WebRTC (browser cannot play raw RTSP).
- YOLO boxes overlay the live frame (`GET /api/detections/live`, detector overlay on port 8092).
- Detection log and today’s stats refresh on a short poll (`POLL_INTERVAL_MS`).
- Waste composition for the current range is shown beside the log.

## FR-3 Waste detections

- The operator lists detections with camera, class, category, confidence, quantity, location, and time.
- Filters narrow the list (see `web/src/lib/wasteFilters.js`).
- An operator may add a detection manually (`POST /api/detections`).
- Snapshots are stored on `detection_images` when an image is attached.

## FR-4 Cameras

- List, create, update, and delete cameras (`/api/cameras`).
- Each camera has code (`CAM-01`), name, location, stream URL, protocol, and detection toggle.
- `POST /api/cameras/{code}/test` probes whether the stream host is reachable.

## FR-5 Reports and analytics

- Trends and composition charts use `/api/stats/today`, `/stats/composition`, `/stats/trends`.
- Filing a cleanup report writes a `reports` row (`POST /api/reports`).
- CSV/PDF export is done in the browser; there is no `export_history` table.

## FR-6 Waste catalog and quotas

- Categories and classifications are maintained via `/api/waste-catalog`.
- Quotas set a count limit per period (daily / weekly / monthly), optionally scoped to a camera or category.
- When detections exceed a quota, `WasteQuotaMonitor` can raise a notification.

## FR-7 Notifications and settings

- Operators read and mark notifications (`/api/notifications`).
- Confidence threshold and related options live in `system_settings` (`GET`/`PUT /api/settings`).

## FR-8 Detector ingest

- The Python service posts overlay boxes and optional log rows to `POST /api/detections/live`.
- The request must send `X-Detector-Key` matching `DETECTOR_KEY`.
- Raw YOLO labels are mapped to `waste_classifications` by `WasteClassifier`.
