# How this repository meets the course criteria

The instructor’s sample tree (`frontend/`, `backend/src/`, `assets/`, root `database/`) is an **example**. The written rule is: customize to the actual project (web, and in our case also a detector and a stream gateway).

This file is the procedure we followed so the group can review it against the 100-point rubric.

## Criteria map

| Criteria | Points | What we did in *this* repo |
|----------|--------|----------------------------|
| Project structure and organization | 25 | Top level is `web`, `api`, `detector`, `gateway`, `docs`, `tests`. Matches the four running processes. |
| File/folder naming and consistency | 10 | kebab/lowercase service folders; Laravel and Vite names unchanged; UI folders = side-menu modules. |
| Feature / module organization | 15 | `web/src/components/{stage,detections,cameras,reports,log,settings}`; API controllers match `routes/api.php`. |
| Code organization and maintainability | 15 | Laravel `Controllers`, `Models`, `Support`, `Services`, `Middleware`; React `api/`, `stores/`, `hooks/`, `lib/`. |
| Database organization | 10 | Migrations + seeders in `api/database/`; schema write-up in `docs/database/`. |
| Documentation | 10 | All required docs under `docs/` (see table below). |
| Testing | 5 | PHPUnit in `api/tests`; system checklist in `tests/system/`. |
| Git / version control | 5 | Meaningful commits; no `final2` / `misc`; secrets gitignored. |
| Security and configuration | 5 | `.env.example` / `go2rtc.yaml.example`; detector key; passwords hidden on Camera. |

## Required documentation (filled from this system)

| Course item | Path |
|-------------|------|
| Project description and setup | `README.md` |
| Technology stack | `README.md` |
| System architecture | `docs/architecture/system-overview.md` |
| Database / schema | `docs/database/schema.md` |
| System diagrams | `docs/diagrams/*.mmd` |
| User / technical docs | `docs/user-manual/`, `docs/api/`, `docs/requirements/` |
| Testing documentation | `docs/testing/test-plan.md` |

`docs/` folder names match the sample **because those are the required document types**. Their **contents** describe Tapo, go2rtc, YOLO-World, Sanctum, and Paco Beach — not a generic app.

## What we did not copy

| Sample | This system | Reason |
|--------|-------------|--------|
| `frontend/` | `web/` | Vite app name already used in env and imports |
| `backend/src/controllers` | `api/app/Http/Controllers/Api/` | Laravel convention; renaming breaks `artisan` |
| Root `database/` | `api/database/` | Migrations must stay with Laravel |
| `assets/` | `web/public/` | Vite serves login and barangay images |
| Root `tests/unit` + `integration` as empty twins | `api/tests/Unit` + `Feature` | PHPUnit config points here |

No `final/`, `backup/`, or `misc/` folders.

## Data path we organized around

`Tapo RTSP → gateway → web (live) and detector (YOLO) → api → MySQL`

## Organization standards (checklist)

- [x] Clear names (`cameras`, `detections`, `WasteClassifier`)
- [x] Files grouped by purpose / feature
- [x] Frontend, backend, database, tests, docs are separated
- [x] No duplicate leftover (`go2rtc.yaml` at repo root, `.bak`, `command.txt` removed)
- [x] Framework conventions kept
- [x] Secrets out of Git (root `.gitignore` + examples)
- [x] Root `README.md` and `.gitignore`
- [x] Git messages describe *why* (docs / test / chore)

## Security notes

Local-only files: `api/.env`, `web/.env`, `detector/.env`, `gateway/go2rtc.yaml`, `*.pt`, `go2rtc.exe`.

If RTSP or Roboflow keys were ever pushed, rotate them.
