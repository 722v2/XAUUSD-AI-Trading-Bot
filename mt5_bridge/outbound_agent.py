from __future__ import annotations

"""Outbound-only relay agent.

Runs on the Windows machine that owns the MT5 terminal. It opens HTTPS requests
to the Render application; no inbound port or tunnel is required. It forwards
authenticated relay jobs to the existing loopback-only MT5 bridge and returns
the exact HTTP status/body to Render.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote

SERVER_URL = os.environ.get("MT5_RELAY_SERVER_URL", "").strip().rstrip("/")
TOKEN = os.environ.get("MT5_BRIDGE_TOKEN", "").strip()
LOCAL_BRIDGE_URL = os.environ.get("MT5_LOCAL_BRIDGE_URL", "http://127.0.0.1:8765").strip().rstrip("/")
POLL_SECONDS = max(1, min(10, int(os.environ.get("MT5_RELAY_POLL_SECONDS", "2"))))
REQUEST_TIMEOUT = 15


def request(url: str, method: str = "GET", payload=None, timeout: int = REQUEST_TIMEOUT):
    data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    headers = {"X-Bridge-Token": TOKEN, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read(1_048_576)
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except (ValueError, UnicodeDecodeError):
                body = {"error": "INVALID_LOCAL_RESPONSE"}
            return response.status, body
    except urllib.error.HTTPError as exc:
        raw = exc.read(1_048_576)
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError):
            body = {"error": "INVALID_LOCAL_RESPONSE"}
        return exc.code, body


def main() -> int:
    if not SERVER_URL.startswith("https://"):
        print("ERROR: MT5_RELAY_SERVER_URL must be the HTTPS Render service URL.")
        return 2
    if not TOKEN:
        print("ERROR: MT5_BRIDGE_TOKEN is required.")
        return 2
    print("MT5 outbound relay started.")
    print("Render:", SERVER_URL)
    print("Local bridge:", LOCAL_BRIDGE_URL)
    print("No inbound tunnel or public Windows port is used.")
    while True:
        try:
            status, body = request(SERVER_URL + "/api/mt5/relay/poll", timeout=25)
            if status != 200:
                print("Relay poll failed:", status, body.get("error", "HTTP_ERROR"))
                time.sleep(POLL_SECONDS)
                continue
            job = body.get("job")
            if not isinstance(job, dict):
                time.sleep(POLL_SECONDS)
                continue
            job_id = job.get("id")
            path = job.get("path")
            method = job.get("method", "GET")
            payload = job.get("body")
            if not isinstance(job_id, str) or not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
                print("Rejected malformed relay job.")
                continue
            if any(part in path for part in ("\r", "\n", "://")):
                print("Rejected unsafe relay path.")
                continue
            local_status, local_body = request(LOCAL_BRIDGE_URL + path, method, payload)
            result = {"id": job_id, "status": local_status, "body": local_body}
            result_status, result_body = request(SERVER_URL + "/api/mt5/relay/result", "POST", result)
            if result_status != 200:
                print("Relay result delivery failed:", result_status, result_body.get("error", "HTTP_ERROR"))
        except KeyboardInterrupt:
            print("Relay stopped.")
            return 0
        except Exception as exc:
            print("Relay connection error:", type(exc).__name__)
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
