# Testing

This project is Laravel + React + Python. Tests live where each framework expects them. A second copy of `unit/` / `integration/` at the repo root would duplicate Laravel’s `api/tests` and break `php artisan test`.

## Layers

| Layer | Where | How to run |
|-------|--------|------------|
| Unit | `api/tests/Unit` | `cd api && php artisan test --testsuite=Unit` |
| Integration (HTTP + DB) | `api/tests/Feature` | `cd api && php artisan test --testsuite=Feature` |
| System (operator flows) | `tests/system/operator-checklist.md` | Manual, all four services up |

PHPUnit is configured in `api/phpunit.xml` (SQLite `:memory:`, `APP_ENV=testing`).

## Automated cases

**Unit**

- `WasteClassifierTest` — YOLO label `plastic bottle` maps to catalog type `Plastic Bottle`; confidence `0.85` stores as `85`.

**Feature / integration**

- `AuthLoginTest` — valid login returns a token; invalid password is rejected; `/cameras` is 401 without a token.
- `CameraApiTest` — authenticated create + list.
- `DetectionIngestTest` — wrong detector key is 401; valid key caches overlay boxes and writes a detection + log row.

## System tests

Walk through `tests/system/operator-checklist.md` before a demo: login → live stream → overlay → detections table → camera test → file a report.

## Not automated yet

- React component tests (Vite has no Vitest suite yet).
- Detector Python unit tests (needs weights + a frame fixture).
- go2rtc process tests (depends on a physical Tapo).

Those stay on the system checklist until the group adds Vitest or pytest.
