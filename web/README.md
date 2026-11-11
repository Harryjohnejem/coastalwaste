# Coastal waste dashboard (React + Vite)

Operator UI for the Computer Vision-Based Coastal Waste Monitoring and Reporting System.
Modules follow the side menu: live stage, detections, cameras, reports.

## Quick start

```bash
cd web
cp .env.example .env
npm install
npm run dev
```

Set `VITE_DEMO_EMAIL` and `VITE_DEMO_PASSWORD` to the user in `api/database/seeders/AdminUserSeeder.php`.
Open the URL Vite prints (usually `http://localhost:5173`).

## Environment

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Laravel API base, including `/api` (default `http://localhost:8000/api`) |
| `VITE_DETECTOR_OVERLAY_URL` | Detector overlay endpoint (default `http://127.0.0.1:8092/overlay`) |
| `VITE_DEMO_EMAIL` / `VITE_DEMO_PASSWORD` | Auto-login when no token is stored |

## Auth (Sanctum bearer)

- Login page: `/login` → `POST /login` → `{ token, user }`
- Token stored in Zustand + `localStorage` (`tidalwatch-auth`)
- Axios attaches `Authorization: Bearer <token>`; `401` clears auth and redirects to `/login`
- Dashboard auto-signs in with `VITE_DEMO_*` when no token is stored

## Live camera

Raw Tapo RTSP is not playable in the browser. `gateway/` (go2rtc) restreams `cam01` as WebRTC.
The detector overlay is polled from `VITE_DETECTOR_OVERLAY_URL`.
Detection log and stats refresh every **5 seconds** (`POLL_INTERVAL_MS` in `src/constants.js`).

## Scripts

- `npm run dev` — development server
- `npm run build` — production build
- `npm run preview` — preview production build
