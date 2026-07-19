# TidalWatch — Coastal Waste Monitoring (Frontend)

React 18 + Vite frontend for the Computer Vision-Based Coastal Waste Monitoring and Reporting System. Layout, colors, and interactions are ported from `coastal-waste-monitor-template.html`.

## Quick start

```bash
cd web
cp .env.example .env
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Environment

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Laravel API base, including `/api` (default `http://localhost:8000/api`) |
| `VITE_AUTH_REQUIRED` | Set to `true` to require Sanctum login before the dashboard. Default is off so the UI stays usable while the API skeleton has no `/login`. |

## Auth (Sanctum bearer)

- Login page: `/login` → `POST /login` → `{ token, user }`
- Token stored in Zustand + `localStorage` (`tidalwatch-auth`)
- Axios attaches `Authorization: Bearer <token>`; `401` clears auth and redirects to `/login`
- Dashboard auto-signs in with demo credentials when no token is stored (see `.env` `VITE_DEMO_*`)

**Demo credentials:** `operator@tidalwatch.test` / `password`

To remove auth in one commit, delete:

- `src/pages/Login.jsx`
- `src/stores/useAuthStore.js`
- `src/api/auth.js`
- `src/components/common/RequireAuth.jsx`
- Bearer / 401 logic in `src/api/client.js`
- Login route + `RequireAuth` wrapper in `src/App.jsx`

## RTSP gateway

Browsers cannot play raw RTSP. Point cameras at an HLS (`.m3u8`) or WebRTC output from a gateway such as:

**MediaMTX** — ingest RTSP, publish HLS path, set the camera `stream_url` to the HLS playlist.

**go2rtc** — add the RTSP source, use its HLS or WebRTC endpoint in the camera settings.

Until a playable URL is configured, the viewport shows the sonar “Awaiting camera signal” state with a gateway hint for RTSP sources.

## Polling

`/detections` and `/stats/today` refresh every **15 seconds** (`POLL_INTERVAL_MS` in `src/constants.js`).

```js
// TODO: replace polling with Laravel WebSockets/Reverb or Pusher
```

## Suggested API additions

The Laravel API in `../api` implements all endpoints the UI expects. Future enhancements:

- WebSockets/Reverb for live detections instead of polling
- Bounding-box overlay payloads on detections or a dedicated stream endpoint
- Real CV pipeline integration for camera inference stats

## Scripts

- `npm run dev` — development server
- `npm run build` — production build
- `npm run preview` — preview production build
