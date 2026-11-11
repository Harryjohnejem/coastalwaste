#!/usr/bin/env bash
# Always load gateway/.env before go2rtc so ${TAPO_*} in go2rtc.yaml expand.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "missing gateway/.env — copy .env.example and set TAPO_HOST"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${TAPO_HOST:-}" || -z "${TAPO_RTSP_USER:-}" || -z "${TAPO_RTSP_PASS:-}" ]]; then
  echo "TAPO_HOST / TAPO_RTSP_USER / TAPO_RTSP_PASS must be set in .env"
  exit 1
fi

echo "[go2rtc] TAPO_HOST=${TAPO_HOST}"
if [[ -z "${TAPO2_HOST:-}" || -z "${TAPO2_RTSP_USER:-}" || -z "${TAPO2_RTSP_PASS:-}" ]]; then
  echo "[go2rtc] warning: second camera account is incomplete — cam03 and cam04 stay offline until TAPO2_HOST, TAPO2_RTSP_USER, and TAPO2_RTSP_PASS are set. CAM-01 and CAM-02 still start."
  if [[ -n "${TAPO2_HOST:-}" ]]; then
    echo "[go2rtc] TAPO2_HOST=${TAPO2_HOST}"
  fi
else
  echo "[go2rtc] TAPO2_HOST=${TAPO2_HOST}"
fi
exec ./go2rtc.exe -config go2rtc.yaml
