from __future__ import annotations
import os
from dataclasses import dataclass
from urllib.parse import urlsplit
from dotenv import load_dotenv

ROOT = __import__("pathlib").Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env", override=False)

@dataclass(frozen=True)
class Config:
    server_url: str
    token: str
    agent_id: str
    symbol: str
    environment: str
    poll_seconds: float
    heartbeat_seconds: float
    database_path: str
    terminal_path: str | None
    live_trading_enabled: bool

def load_config() -> Config:
    raw = os.getenv("MT5_RELAY_SERVER_URL", "").strip().rstrip("/")
    parsed = urlsplit(raw)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("MT5_RELAY_SERVER_URL must be an HTTPS origin")
    if parsed.path not in ("", "/"):
        raise ValueError("MT5_RELAY_SERVER_URL must be the Render origin only, without an API path")
    token = os.getenv("MT5_BRIDGE_TOKEN", "").strip()
    if len(token) < 32:
        raise ValueError("MT5_BRIDGE_TOKEN must be a secret of at least 32 characters, identical on Render")
    environment = os.getenv("MT5_EXECUTION_ENVIRONMENT", "DEMO").strip().upper()
    if environment not in ("DEMO", "LIVE"):
        raise ValueError("MT5_EXECUTION_ENVIRONMENT must be DEMO or LIVE")
    live_trading_enabled = os.getenv("MT5_LIVE_TRADING_ENABLED", "false").strip().lower() == "true"
    poll = float(os.getenv("MT5_RELAY_POLL_SECONDS", "2"))
    heartbeat = float(os.getenv("MT5_HEARTBEAT_SECONDS", "10"))
    if not 0.5 <= poll <= 10 or not 3 <= heartbeat <= 60:
        raise ValueError("Polling must be 0.5–10 seconds and heartbeat 3–60 seconds")
    return Config(raw, token, os.getenv("MT5_AGENT_ID", "windows-mt5-demo-01").strip(), os.getenv("MT5_SYMBOL", "XAUUSD").strip(), environment, poll, heartbeat, os.getenv("MT5_OUTBOX_PATH", str(ROOT / "mt5_bridge_v2" / "outbox.sqlite3")), os.getenv("MT5_TERMINAL_PATH") or None, live_trading_enabled)
