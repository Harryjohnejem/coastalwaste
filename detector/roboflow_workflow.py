"""Roboflow Workflow client for the trained local-datasets YOLOv11 model.

Calls the serverless workflow endpoint with Bearer auth. The workflow declares
a single image input and no extra parameters. Output names come from the
response, not from a fixed schema.
"""

from __future__ import annotations

import base64
import time
from pathlib import Path
from typing import Any

import httpx

SERVERLESS = "https://serverless.roboflow.com"
DEFAULT_WORKSPACE = "dioquino-jims-carl-k"
DEFAULT_WORKFLOW_ID = "local-datasets-vlocal-datasets-fgmmm-2-yolo11n-t1-logic"
IMAGE_DIR = Path(__file__).resolve().parent / "runs" / "workflow-images"


class RoboflowWorkflowError(RuntimeError):
    """Workflow request failed after retries."""


def run_workflow(
    client: httpx.Client,
    image_jpeg: bytes,
    *,
    api_key: str,
    workspace_name: str = DEFAULT_WORKSPACE,
    workflow_id: str = DEFAULT_WORKFLOW_ID,
    parameters: dict[str, Any] | None = None,
    timeout: float = 25.0,
    retries: int = 2,
) -> list[dict[str, Any]]:
    """POST one JPEG to the workflow. Returns one dict per input image.

    This workflow has no declared parameters besides ``image``. Extra
    ``parameters`` are sent only when the caller supplies them.
    """
    if not api_key.strip():
        raise RoboflowWorkflowError("ROBOFLOW_API_KEY is empty")
    if not image_jpeg:
        raise RoboflowWorkflowError("image is empty")

    body: dict[str, Any] = {
        "inputs": {
            "image": {
                "type": "base64",
                "value": base64.b64encode(image_jpeg).decode("ascii"),
            }
        }
    }
    if parameters:
        body["parameters"] = parameters

    url = f"{SERVERLESS}/{workspace_name}/workflows/{workflow_id}"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    delay = 0.4
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            response = client.post(url, headers=headers, json=body, timeout=timeout)
            if response.status_code == 429 or response.status_code >= 500:
                raise RoboflowWorkflowError(
                    f"workflow HTTP {response.status_code}: {response.text[:180]}"
                )
            response.raise_for_status()
            data = response.json()
            return _outputs(data)
        except (httpx.HTTPError, RoboflowWorkflowError, ValueError) as exc:
            last_error = exc
            if attempt >= retries:
                break
            time.sleep(delay)
            delay *= 2
    raise RoboflowWorkflowError(f"workflow failed: {last_error}") from last_error


def _outputs(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        entries = data
    elif isinstance(data, dict):
        raw = data.get("outputs")
        entries = raw if isinstance(raw, list) else [data]
    else:
        raise RoboflowWorkflowError("workflow response was not a list or object")
    cleaned: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise RoboflowWorkflowError("workflow output entry was not an object")
        cleaned.append(_spill_image_blobs(entry))
    return cleaned


def _spill_image_blobs(entry: dict[str, Any]) -> dict[str, Any]:
    """Write base64 image outputs to disk and drop the blob from the dict."""
    out: dict[str, Any] = {}
    for key, value in entry.items():
        raw = _maybe_image_bytes(value)
        if raw is None:
            out[key] = value
            continue
        IMAGE_DIR.mkdir(parents=True, exist_ok=True)
        path = IMAGE_DIR / f"{key}-{time.time_ns()}.jpg"
        path.write_bytes(raw)
        out[key] = {"path": str(path)}
    return out


def _maybe_image_bytes(value: Any) -> bytes | None:
    if not isinstance(value, str) or len(value) < 1000:
        return None
    try:
        raw = base64.b64decode(value, validate=False)
    except Exception:
        return None
    if raw.startswith(b"\xff\xd8\xff") or raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return raw
    return None


def detection_payloads(entry: dict[str, Any]) -> list[dict[str, Any]]:
    """Detection objects from whatever output keys the workflow returned.

    Observed shape: ``{ "<output name>": { "image": {...}, "predictions": [...] } }``.
    """
    found: list[dict[str, Any]] = []
    for value in entry.values():
        if isinstance(value, dict) and isinstance(value.get("predictions"), list):
            found.append(value)
        elif (
            isinstance(value, list)
            and value
            and isinstance(value[0], dict)
            and "class" in value[0]
        ):
            found.append({"image": {}, "predictions": value})
    return found
