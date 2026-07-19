# TidalWatch waste detector (Python · YOLO-World)

Open-vocabulary YOLO that matches **text embeddings** of waste classes
(plastic bottle, fishing net, styrofoam, …) against the live go2rtc frame,
then posts boxes to the Laravel API for the dashboard overlay + log.

## Setup

Install **Python 3.10+** from https://www.python.org/downloads/ (enable “Add to PATH”).

```bash
cd detector
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
# source .venv/bin/activate

pip install -r requirements.txt
```

First run downloads `yolov8s-worldv2.pt` (~50MB+).

## Run (with go2rtc + API already up)

```bash
python app.py
# or: uvicorn app:app --host 127.0.0.1 --port 8090
```

Health: http://127.0.0.1:8090/health

## Env

See `.env` — `DETECTOR_KEY` must match `DETECTOR_KEY` in `api/.env`.
