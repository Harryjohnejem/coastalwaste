# Operator guide

For barangay staff using the dashboard at `http://localhost:5173`.

All four services must be running (gateway, API, detector, web). See the root `README.md`.

## Sign in

1. Open the login page.
2. Use the account created by `AdminUserSeeder` (ask the team lead for the local password).
3. After a successful login you land on **Live Monitor**.

If the API is down, the login form shows an error and the dashboard will not load cameras.

## Live Monitor

- The large viewport is the selected camera (WebRTC from go2rtc).
- Colored boxes are waste the detector just saw.
- The right-hand **Detection Log** lists recent hits. **Waste Composition** shows the mix for the last 24 hours.
- Use the camera rail to switch `CAM-01`, `CAM-02`, and so on.
- The control deck can snapshot or adjust playback; detection still depends on the Python service.

If the viewport says it is waiting for a signal: start `gateway` and confirm `go2rtc.yaml` has a working Tapo RTSP URL.

## Waste Detections

1. Open **Waste Detections** on the left menu.
2. Use the filter bar to narrow by class, camera, or date.
3. Open a row to view the snapshot (when one exists).
4. **Add waste** saves a manual detection when the camera missed an item.

## Cameras

1. Open **Cameras**.
2. Add a camera: name, location (sector), stream URL from go2rtc (not the raw `rtsp://` if the browser must play it).
3. Toggle detection on/off per camera.
4. **Test** checks whether the stream host answers. It does not start YOLO by itself.

## Reports and analytics

1. Open **Reports & Analytics**.
2. Review trends and composition (30-day range on this module).
3. File a report when a cleanup should be recorded. The API stores `report_number`, type, period, remarks, and recommendations.
4. Export CSV/PDF from the dashboard if you need a file for the barangay office.

## Notifications and settings

- The top bar bell lists cleanup threshold alerts (Waste building up, Cleanup needed, Cleaned), new detections, and system alerts. Mark them read when acknowledged.
- When a camera reaches the warning level or the cleanup limit, a banner appears at the top of Live Monitoring and the Main Dashboard. Set the limit and warning level in Settings → Notifications.
- Settings (gear) hold the detection confidence threshold and related options. Those values are stored in `system_settings`, not in a separate threshold table.

## If something looks empty

| Symptom | Check |
|---------|--------|
| No video | `gateway` + Tapo online + `go2rtc.yaml` |
| Video but no boxes | `detector` + matching `DETECTOR_KEY` |
| Login loop | `api` running + correct `VITE_API_URL` |
| No detections in the table | Detector posting `detections` array, or add one manually |

## Waste status and verifying cleaning

- **Waste Detected / Still Present**: the waste is on camera.
- **No Longer Visible**: the camera no longer sees it. This does not mean it was cleaned.
- **Cleaning Verified**: after the waste is physically collected on site, open **Waste Detections**, click **Verify cleaning** on the record (or select several and use **Verify cleaning** at the top). Your name and the time are saved. Only the Barangay Sanitary Inspector or an administrator can do this.
