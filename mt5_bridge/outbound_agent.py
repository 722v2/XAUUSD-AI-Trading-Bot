from __future__ import annotations

"""Concurrent outbound relay for a local MT5 bridge.

Each worker polls one Render relay job and executes it locally. This lets the
server's parallel M1/M5/M15/H1 requests be serviced concurrently without
opening an inbound port on the Windows machine.
"""
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

from dotenv import load_dotenv

load_dotenv()

RAW_SERVER_URL = os.environ.get("MT5_RELAY_SERVER_URL", "").strip()
TOKEN = os.environ.get("MT5_BRIDGE_TOKEN", "").strip()
LOCAL_BRIDGE_URL = os.environ.get("MT5_LOCAL_BRIDGE_URL", "http://127.0.0.1:8765").strip().rstrip("/")
POLL_SECONDS = max(0.2, min(5.0, float(os.environ.get("MT5_RELAY_POLL_SECONDS", "0.5"))))
WORKERS = max(4, min(12, int(os.environ.get("MT5_RELAY_WORKERS", "4"))))
POLL_TIMEOUT = 15
JOB_TIMEOUT = 12
_thread_local = threading.local()


def normalize_server_url(value: str) -> str:
    """Accept the Render origin only; strip accidental relay-proxy suffixes."""
    if not value:
        return ""
    parsed = urlsplit(value)
    path = parsed.path.rstrip("/")
    suffix = "/api/mt5/relay/proxy"
    while path.endswith(suffix):
        path = path[:-len(suffix)].rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", "")).rstrip("/")


SERVER_URL = normalize_server_url(RAW_SERVER_URL)


def _session_headers(payload=None) -> dict[str, str]:
    headers = {"X-Bridge-Token": TOKEN, "Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    return headers


def request(url: str, method: str = "GET", payload=None, timeout: int = JOB_TIMEOUT):
    data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = Request(url, data=data, headers=_session_headers(payload), method=method)
    try:
        with urlopen(req, timeout=timeout) as response:
            raw = response.read(1_048_576)
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except (ValueError, UnicodeDecodeError):
                body = {"error": "INVALID_LOCAL_RESPONSE"}
            return response.status, body
    except HTTPError as exc:
        raw = exc.read(1_048_576)
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError):
            body = {"error": "INVALID_LOCAL_RESPONSE"}
        return exc.code, body
    except (URLError, TimeoutError, OSError):
        return 503, {"error": "RELAY_TRANSPORT_ERROR"}


def valid_job(job):
    if not isinstance(job, dict):
        return False
    job_id, path = job.get("id"), job.get("path")
    if not isinstance(job_id, str) or not job_id or not isinstance(path, str):
        return False
    if not path.startswith("/") or path.startswith("//"):
        return False
    if any(part in path for part in ("\r", "\n", "://", "\\", "\x00")):
        return False
    return True


def worker(worker_id: int, stop: threading.Event) -> None:
    poll_url = SERVER_URL + "/api/mt5/relay/poll"
    result_url = SERVER_URL + "/api/mt5/relay/result"
    while not stop.is_set():
        try:
            status, body = request(poll_url, timeout=POLL_TIMEOUT)
            if status != 200:
                if status not in (204,):
                    print(f"[worker {worker_id}] poll failed: HTTP {status} {body.get('error', 'HTTP_ERROR')}")
                stop.wait(POLL_SECONDS)
                continue
            job = body.get("job")
            if not job:
                stop.wait(POLL_SECONDS)
                continue
            if not valid_job(job):
                print(f"[worker {worker_id}] rejected malformed relay job")
                stop.wait(0.1)
                continue
            local_status, local_body = request(
                LOCAL_BRIDGE_URL + job["path"],
                str(job.get("method", "GET")).upper(),
                job.get("body"),
                timeout=JOB_TIMEOUT,
            )
            result_status, result_body = request(
                result_url, "POST",
                {"id": job["id"], "status": local_status, "body": local_body},
                timeout=JOB_TIMEOUT,
            )
            if result_status != 200:
                print(f"[worker {worker_id}] result delivery failed: HTTP {result_status} {result_body.get('error', 'HTTP_ERROR')}")
        except KeyboardInterrupt:
            stop.set()
            return
        except Exception as exc:
            print(f"[worker {worker_id}] relay error: {type(exc).__name__}")
            stop.wait(POLL_SECONDS)


def main() -> int:
    if not SERVER_URL.startswith("https://"):
        print("ERROR: MT5_RELAY_SERVER_URL must be the HTTPS Render service URL.")
        return 2
    if not TOKEN:
        print("ERROR: MT5_BRIDGE_TOKEN is required.")
        return 2
    if not LOCAL_BRIDGE_URL.startswith("http://127.0.0.1:") and not LOCAL_BRIDGE_URL.startswith("http://localhost:"):
        print("ERROR: MT5_LOCAL_BRIDGE_URL must point to loopback.")
        return 2
    print(f"MT5 outbound relay started; workers={WORKERS}.")
    print("Render:", SERVER_URL)
    print("Local bridge:", LOCAL_BRIDGE_URL)
    print("No inbound tunnel or public Windows port is used.")
    stop = threading.Event()
    try:
        with ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="mt5-relay") as pool:
            futures = [pool.submit(worker, i + 1, stop) for i in range(WORKERS)]
            for future in futures:
                future.result()
    except KeyboardInterrupt:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
