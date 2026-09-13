# Non-functional requirements

## NFR-1 Local area network

Tapo cameras stay on the barangay LAN. The browser never opens the raw RTSP URL; go2rtc on the same machine restreams to `127.0.0.1:1990`.

## NFR-2 Latency

- Live view uses go2rtc WebRTC (target: about one second or less).
- Detector overlay poll: `OVERLAY_POLL_MS` (1000 ms).
- Detection log / stats poll: `POLL_INTERVAL_MS` (5000 ms).

## NFR-3 Security

- Dashboard and most API routes require Sanctum.
- Detector ingest is a separate key (`X-Detector-Key`), not the operator password.
- Camera RTSP passwords, Roboflow keys, and `.env` files are not stored in Git.
- Camera `password` is hidden on the Eloquent model (`$hidden`).

## NFR-4 Data

- Production/dev database: MySQL `coastal_waste_monitoring_reporting_db`.
- Automated tests use SQLite in memory (`api/phpunit.xml`).
- Schema is normalized to 3NF (see `docs/database/schema.md` and `docs/diagrams/logical-erd.mmd`).

## NFR-5 Maintainability

- Frontend modules match the side menu: live, detections, cameras, reports.
- Backend follows Laravel folders (`Controllers`, `Models`, `routes`, `database`).
- Each of the four services has its own README and `.env.example` / yaml example.
