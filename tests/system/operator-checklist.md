# System test checklist

Run with gateway, API, detector, and web all started (root `README.md` run order).

## Auth

- [ ] Login page loads at `/login`
- [ ] Wrong password stays on login and shows an error
- [ ] Correct seeded admin opens Live Monitor
- [ ] Refresh keeps the session (token in `localStorage`)

## Live Monitor

- [ ] Viewport shows the Tapo stream (not the “awaiting signal” state)
- [ ] Camera rail switches cameras
- [ ] When waste is in frame, overlay boxes appear
- [ ] Detection log gains a row within a few seconds
- [ ] Composition chart is not empty after detections exist

## Waste Detections

- [ ] Table lists API detections (class, camera, time)
- [ ] Filters change the visible rows
- [ ] Manual **Add waste** creates a row that survives refresh

## Cameras

- [ ] Existing cameras render
- [ ] Add camera with a go2rtc URL succeeds
- [ ] Test stream returns a result without crashing the modal

## Reports

- [ ] Trends / composition render
- [ ] Filing a report returns a `report_number`
- [ ] Export control produces a file in the browser

## Failure cases

- [ ] Stop the detector: video still plays, overlay goes empty
- [ ] Stop go2rtc: viewport shows awaiting signal
- [ ] Stop the API: login / polls fail cleanly (no white screen)
