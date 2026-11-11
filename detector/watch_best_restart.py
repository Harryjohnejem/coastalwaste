"""Watch weights/trained/best.pt; when it updates, print a restart hint.
Optionally restart app.py if EXPAND8_AUTORESTART=1.
"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BEST = ROOT / "weights" / "trained" / "best.pt"


def main() -> None:
    if not BEST.is_file():
        print("[watch] no best.pt yet")
    last = BEST.stat().st_mtime if BEST.is_file() else 0.0
    print(f"[watch] monitoring {BEST} mtime={last}")
    while True:
        time.sleep(20)
        if not BEST.is_file():
            continue
        mt = BEST.stat().st_mtime
        if mt <= last:
            continue
        print(f"[watch] best.pt updated → {BEST} ({BEST.stat().st_size} bytes)")
        last = mt
        if os.getenv("EXPAND8_AUTORESTART", "").strip() in {"1", "true", "yes"}:
            # Stop old app.py then start fresh
            try:
                subprocess.run(
                    [
                        "powershell",
                        "-NoProfile",
                        "-Command",
                        (
                            "Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | "
                            "Where-Object { $_.CommandLine -like '*app.py*' } | "
                            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
                        ),
                    ],
                    check=False,
                )
            except Exception as exc:  # noqa: BLE001
                print("[watch] stop app failed:", exc)
            time.sleep(2)
            subprocess.Popen(
                ["python", "app.py"],
                cwd=str(ROOT),
                creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
            )
            print("[watch] restarted app.py")
        else:
            print("[watch] restart detector: cd detector && python app.py")


if __name__ == "__main__":
    main()
