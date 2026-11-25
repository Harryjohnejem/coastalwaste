# TidalWatch waste detector (Python · YOLOv11)

Each configured camera/lens has its own JPEG reader, ByteTrack tracker, and
OpenCV MOG2 motion model. A shared YOLOv11x ONNX model (`weights/trained/best.onnx`)
runs under one inference lock. Live HUD boxes come from `/overlay?camera_id=`
as soon as YOLO + ByteTrack finish; Laravel recording still waits for
track confirmation at `RECORD_CONF`.

Tapo C545D dual lens: CAM-01 = go2rtc `cam01` (`/stream1`), CAM-02 = `cam02`
(`/stream6`). Credentials stay in `detector/.env` / `gateway/.env` — never in
the browser. Start go2rtc with `gateway/start.sh` so `${TAPO_*}` expands.

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

The live xlarge detector runs through ONNX Runtime's CPU provider; no GPU or
CUDA package is required. CPU inference is slower than GPU inference, so the
live crop mode and frame interval determine how quickly each camera updates.
The exporter keeps FP32 and checks class names/order in both the source
checkpoint and generated ONNX. Startup stops on a mismatch rather than
publishing boxes under potentially incorrect class names.

## Run (gateway + API already up)

```bash
python app.py
```

Health: http://127.0.0.1:8092/health

Overlay (one camera only, fail-closed):
`http://127.0.0.1:8092/overlay?camera_id=CAM-02`

YOLO searches at `PROPOSAL_CONF` (default 0.25) so dataset classes can be found.
Solid HUD labels start at `CONF` (default 0.70, never below). Proposal-level
hits draw immediately as dashed **provisional** boxes; they are not written to
MySQL. `RECORD_CONF` (default 0.80) plus 3 track frames is the database gate.
Known dataset classes are never shown as Unlabeled.

`DETECTION_MODE` values:

- `tiles_2x2` — 4 overlapping quadrants on wide Tapo frames (default live path after timing bench)
- `full_plus_tiles` — full frame + 4 tiles (alias: `two_strip`)
- `full_frame` — one 640 predict (faster, weaker on distant waste)

JPEG capture uses `STREAM_CAPTURE_INTERVAL_S` (default 0.1s) after a good frame.
`STREAM_RECONNECT_S` (default 0.5s) is only the failure backoff. Identity class
remaps (`CLASS_IDENTITY_REMAP`) stay off unless evaluation shows they help
without hiding model errors.

Offline measurement:

```bash
python bench_detect.py
python eval_detect.py
```

## Train locally from Roboflow annotations

See `.env` — `DETECTOR_KEY` must match `DETECTOR_KEY` in `api/.env`.

Live frames use the local YOLOv11x ONNX file, not the Roboflow workflow.
Roboflow remains optional for dataset download / smoke tests only.

## Use weights (12) checkpoint

Place `weights (12).pt` in `C:\Users\Admin\Downloads` and run:

```bash
python export_onnx.py
```

The exporter checks all 14 class names and their order against the live
detector before replacing
`weights/trained/best.onnx`. It keeps backups of the previous ONNX and PyTorch
model. Restart the detector after a successful export; its cameras load
`best.onnx` at startup. If it rejects the class list, reconcile the training
dataset and live catalog before deployment; changing names alone cannot add a
class the model was not trained to recognize.

Measure box and class quality on labeled camera images after export:

```bash
python eval_detect.py --dataset datasets/local-merged --split valid
python bench_detect.py
```

The checkpoint is YOLOv11x with 14 classes, including `Plastic Spoon`. Keep
the model and catalog class order identical so saved labels remain correct.

Smoke check (needs the key and network):

```bash
python smoke_roboflow_workflow.py
```
