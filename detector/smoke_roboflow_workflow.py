"""Smoke test: one image against the trained local-datasets workflow."""

from __future__ import annotations

import os
from pathlib import Path

import cv2
import httpx
import numpy as np
from dotenv import load_dotenv

from roboflow_workflow import detection_payloads, run_workflow

ROOT = Path(__file__).resolve().parent


def test_parse_observed_shape() -> None:
    entry = {
        "predictions": {
            "image": {"width": None, "height": None},
            "predictions": [],
        }
    }
    payloads = detection_payloads(entry)
    assert len(payloads) == 1
    assert "predictions" in payloads[0]


def test_live_workflow() -> None:
    load_dotenv(ROOT / ".env")
    key = os.getenv("ROBOFLOW_API_KEY") or ""
    assert key, "ROBOFLOW_API_KEY missing"
    image = np.zeros((64, 64, 3), dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", image)
    assert ok
    with httpx.Client() as client:
        outputs = run_workflow(
            client,
            buf.tobytes(),
            api_key=key,
            workspace_name=os.getenv("ROBOFLOW_WORKSPACE") or "dioquino-jims-carl-k",
            workflow_id=os.getenv("ROBOFLOW_WORKFLOW_ID")
            or "local-datasets-vlocal-datasets-fgmmm-2-yolo11n-t1-logic",
        )
    assert outputs, "workflow returned no outputs"
    assert isinstance(outputs[0], dict)
    assert outputs[0], "workflow output entry has no keys"
    assert detection_payloads(outputs[0]), "no detection payload in workflow output"


if __name__ == "__main__":
    test_parse_observed_shape()
    test_live_workflow()
    print("smoke ok")
