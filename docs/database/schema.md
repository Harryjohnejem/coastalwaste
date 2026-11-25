# Database schema

Executable migrations and seeders live in **`api/database/`** (Laravel). This file is the human-readable schema for the capstone manuscript.

Engine: MySQL (`DB_DATABASE=coastal_waste_monitoring_reporting_db`).
Normalization: 3NF. Laravel support tables (`cache`, `sessions`, `personal_access_tokens`, `migrations`) are omitted from the ERD.

## Table map

| Table | Purpose |
|-------|---------|
| `users` | Operators (name, email, hashed password, role) |
| `cameras` | Shore cameras + stream fields |
| `waste_categories` | Plastic, Paper, Metal, Glass, Wood, Fishing Gear, Styrofoam, Other |
| `waste_classifications` | Types under a category (Plastic Bottle, Fishing Net, …) |
| `detections` | One classified waste event |
| `detection_images` | Snapshot files for a detection |
| `detection_logs` | Raw YOLO label, model name, inference time |
| `reports` | Filed cleanup / summary reports |
| `notifications` | In-app alerts (cleanup threshold, new detections, system) |
| `system_settings` | Key/JSON value (confidence thresholds, cleanup limit and warning level, each camera's last cleanup level) |

## Relationships

- `users` 1—N `reports` (`generated_by`), 1—N `notifications`
- `cameras` 1—N `detections`
- `waste_categories` 1—N `waste_classifications`
- `waste_classifications` 1—N `detections`
- `detections` 1—N `detection_images`, 1—N `detection_logs`

## Design notes (from the implemented schema)

- Detection snapshots are rows in `detection_images`, not blobs on `detections`.
- The cleanup threshold is not its own table: the limit and warning level are `system_settings` values, and each camera's count is computed from the live stream (or Present detections). The table `waste_quotas` was created early on and later dropped by a migration.
- Confidence threshold is a `system_settings` key, not its own table.
- Report CSV/PDF is generated in the React dashboard; there is no `export_history` table.
- Camera stream credentials (`username`, `password`) belong to the camera row (depend only on camera PK). Password is hidden from JSON.

## Migrations (order)

1. `users` (+ password reset, sessions)
2. `cache`
3. `cameras`
4. `waste_categories`
5. `waste_classifications`
6. `detections`
7. `detection_images`
8. `detection_logs`
9. `reports`
10. `notifications`
11. `system_settings`
12. `waste_quotas` (later dropped; replaced by the cleanup threshold)
13. `personal_access_tokens` (Sanctum)

Seeders: `AdminUserSeeder`, `CameraSeeder`, `WasteCategorySeeder`, `WasteClassificationSeeder`, `NotificationSeeder`.

ERD source: `docs/diagrams/logical-erd.mmd`.
