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

## FR-6 Waste catalog and cleanup threshold

- Categories and classifications are maintained via `/api/waste-catalog`.
- The cleanup threshold sets a waste limit per camera (Settings → Notifications: cleanup limit, warning level %, alerts on/off).
- Each camera's count is the waste it shows on the live stream right now (saved Present records when the detector is unreachable).
- Levels: **Normal** (below the warning level), **Building up** (warning level reached), **Full** (limit reached).
- When a camera climbs to a higher level, `WasteLoad` sends one administrator notification; when it is cleaned below the warning level, a "Cleaned" notification follows. A level holds until the count drops below the warning level, so one missed frame does not repeat the alert.
- An alert banner shows on Live Monitoring and the Main Dashboard while any camera is Building up or Full (`GET /api/waste-load`).

## FR-7 Notifications and settings

- Operators read and mark notifications (`/api/notifications`).
- Confidence threshold and related options live in `system_settings` (`GET`/`PUT /api/settings`).

## FR-8 Detector ingest

- The Python service posts overlay boxes and optional log rows to `POST /api/detections/live`.
- The request must send `X-Detector-Key` matching `DETECTOR_KEY`.
- Raw YOLO labels are mapped to `waste_classifications` by `WasteClassifier`.

## FR-8 Waste status and cleaning verification

- **Waste Detected**: the camera detected the waste (just saved).
- **Still Present**: previously detected waste is still visible on the camera.
- **No Longer Visible**: the waste is no longer detected after the absence interval. This is inferred disappearance, **not** proof that the waste was cleaned. It is set automatically (also when detection is turned off).
- **Cleaning Verified**: set **only by a person** (Barangay Sanitary Inspector or an administrator) in Waste Detections → *Verify cleaning* (one record or the selected ones). The verifier and the date and time are stored (`cleaning_verified_by`, `cleaning_verified_at`). The cameras never set or change this status.
- Dashboard, Waste Detections, analytics and reports count **No Longer Visible** and **Cleaning Verified** separately. Older records that were marked "Confirmed Cleaned" automatically were renamed to **No Longer Visible**; no records were removed.
