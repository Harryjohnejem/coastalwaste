# Computer Vision-Based Coastal Waste Monitoring and Reporting System

Barangay operators at Paco Beach (Barangay Gracia) watch Tapo cameras, review YOLO waste detections, get cleanup alerts when a camera's waste reaches the cleanup threshold, and file reports.

This is a **four-service web system** (not mobile or desktop). Folder names follow the services and frameworks we actually run.

```
Tapo RTSP  →  gateway (go2rtc)  →  web (live view)
                         ↓
                   detector (YOLO)
                         ↓
                   api (Laravel)  →  MySQL
```

## Technology stack

| Layer | Technology |
|-------|------------|
| Dashboard | React 18, Vite, Zustand, Axios |
| API | PHP 8.3, Laravel, Sanctum |
| Database | MySQL (`coastal_waste_monitoring_reporting_db`) |
| Detector | Python 3.10+, FastAPI, Ultralytics YOLO-World |
| Streams | go2rtc (Tapo RTSP → WebRTC / JPEG) |

## Services

| Folder | Role | Port |
|--------|------|------|
| `gateway/` | Restream Tapo RTSP for the browser and detector | `1990` |
| `api/` | Auth, cameras, detections, stats, cleanup threshold, reports | `8000` |
| `detector/` | Classify waste on JPEG frames; post boxes to Laravel | `8092` |
| `web/` | Operator UI — live, detections, cameras, reports | `5173` |

## Repository layout

```
coastal-waste-platform/
├── README.md
├── .gitignore
├── docs/
│   ├── requirements/          what the system must do
│   ├── architecture/          four-service design
│   ├── database/              schema notes (3NF)
│   ├── diagrams/              ERD + class diagram (Mermaid)
│   ├── api/                   REST catalog
│   ├── user-manual/           operator steps
│   └── testing/               how tests are organized
├── tests/
│   └── system/                end-to-end operator checklist
├── web/                       React dashboard
├── api/                       Laravel API + migrations + PHPUnit
├── detector/                  YOLO-World worker
└── gateway/                   go2rtc
```

`web/src/components/` is grouped by module (`stage`, `detections`, `cameras`, `reports`).  
`api/database/` holds migrations and seeders.  
Automated unit/integration tests are in `api/tests/` (Laravel / PHPUnit).

## Setup

Copy each example file, then start services in this order.

```bash
# 1. Stream gateway
cd gateway
cp go2rtc.yaml.example go2rtc.yaml   # put the Tapo RTSP URL here
# download go2rtc.exe into this folder (do not commit it)
./go2rtc.exe -config go2rtc.yaml

# 2. Laravel API
cd api
cp .env.example .env
php artisan key:generate
php artisan migrate --seed
php artisan serve
# Upload jobs and Roboflow train-watch (database queue). Keep this running.
php artisan queue:work --queue=default --tries=1 --timeout=600

# 3. Detector
cd detector
cp .env.example .env                 # DETECTOR_KEY must match api/.env
python -m venv .venv
.venv/Scripts/activate
pip install -r requirements.txt
python app.py

# 4. Dashboard
cd web
cp .env.example .env                 # VITE_DEMO_* = AdminUserSeeder account
npm install
npm run dev
```

Open `http://localhost:5173`.

## Documentation

| Required item | File |
|---------------|------|
| Project description + setup | this README |
| Technology stack | this README |
| System architecture | [docs/architecture/system-overview.md](docs/architecture/system-overview.md) |
| Database / schema | [docs/database/schema.md](docs/database/schema.md) |
| System diagrams | [docs/diagrams/](docs/diagrams/) |
| Requirements | [docs/requirements/](docs/requirements/) |
| API | [docs/api/endpoints.md](docs/api/endpoints.md) |
| User guide | [docs/user-manual/operator-guide.md](docs/user-manual/operator-guide.md) |
| Testing | [docs/testing/test-plan.md](docs/testing/test-plan.md) |
| Why folders look like this | [docs/organization-procedure.md](docs/organization-procedure.md) |

Service notes: [web](web/README.md) · [api](api/README.md) · [detector](detector/README.md) · [gateway](gateway/README.md)

## Tests

```bash
cd api
php artisan test
```

System (manual) checklist: [tests/system/operator-checklist.md](tests/system/operator-checklist.md)

## Security

Do not commit `.env`, `go2rtc.yaml`, `*.pt` weights, or `go2rtc.exe`. Use the `*.example` files. `DETECTOR_KEY` is shared only between `api/.env` and `detector/.env`.
