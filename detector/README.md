# Waste detector (Python · YOLO-World)

Open-vocabulary YOLO matches text embeddings of waste classes
(plastic bottle, fishing net, styrofoam, …) against a live go2rtc JPEG frame,
then posts boxes to the Laravel API for the dashboard overlay and detection log.

## Setup

Install **Python 3.10+**. Then:

```bash
cd detector
cp .env.example .env
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
# source .venv/bin/activate

pip install -r requirements.txt
```

First run loads `yolov8s-worldv2.pt` (not committed; Ultralytics downloads it).
`DETECTOR_KEY` in `.env` must match `api/.env`.

## Run (gateway + API already up)

```bash
python app.py
```

Default listen: `http://127.0.0.1:8092` (`PORT` in `.env`).
Health: `http://127.0.0.1:8092/health`
Overlay: `http://127.0.0.1:8092/overlay`

## Train locally from Roboflow annotations

After you annotate on Roboflow, set `ROBOFLOW_API_KEY` in `.env` and run:

```bash
python train_from_roboflow.py
```

That downloads datasets into `datasets/` (gitignored) and writes weights under `weights/trained/`. No Roboflow inference credits are used.
