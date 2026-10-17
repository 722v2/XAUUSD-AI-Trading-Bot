from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    import MetaTrader5 as mt5  # type: ignore[import-not-found]
except ImportError:
    mt5 = None  # type: ignore[assignment]

ROOT = Path(__file__).resolve().parent
DEFAULT_SYMBOL = os.getenv("MT5_SYMBOL", "XAUUSD")
MAX_BODY_BYTES = 16_384
TIMEFRAME_MAP = {
    "M1": ("TIMEFRAME_M1", 60),
    "M5": ("TIMEFRAME_M5", 300),
    "M15": ("TIMEFRAME_M15", 900),
    "H1": ("TIMEFRAME_H1", 3600),
}
SUCCESS_RET_CODES = {"TRADE_RETCODE_DONE", "TRADE_RETCODE_PLACED", "TRADE_RETCODE_DONE_PARTIAL"}


def utc_iso(timestamp: float | int) -> str:
    return datetime.fromtimestamp(float(timestamp), tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stable_order_comment(idempotency_key: str) -> str:
    digest = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:16]
    return "XAUAI-" + digest


def validate_order_payload(payload: Any, symbol: str = DEFAULT_SYMBOL) -> tuple[bool, str]:
    if not isinstance(payload, dict):
        return False, "INVALID_BODY"
    if payload.get("environment") not in ("DEMO", "LIVE"):
        return False, "INVALID_ENVIRONMENT"
    if payload.get("environment") == "LIVE" and not (
        os.getenv("MT5_LIVE_TRADING_ENABLED", "").strip().lower() == "true"
        and os.getenv("MT5_LIVE_CONFIRMATION", "") == "I_UNDERSTAND_LIVE_TRADING_RISK"
    ):
        return False, "LIVE_DISABLED"
    if payload.get("symbol") != "XAUUSD":
        return False, "INVALID_SYMBOL"
    if payload.get("direction") not in ("BUY", "SELL"):
        return False, "INVALID_DIRECTION"
    key = payload.get("idempotencyKey")
    if not isinstance(key, str) or not key.strip() or len(key) > 180:
        return False, "INVALID_IDEMPOTENCY_KEY"
    for field in ("volume", "stopLoss", "takeProfit"):
        value = payload.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not (value > 0) or value == float("inf") or value != value:
            return False, "INVALID_" + field.upper()
    return True, "OK"


class IdempotencyStore:
    """SQLite-backed at-most-once submission ledger; uncertain intents are never auto-resubmitted."""

    def __init__(self, db_path: str | Path):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        with self._connect() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS order_intents (
                    idempotency_key TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    comment TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    result_json TEXT,
                    updated_at TEXT NOT NULL
                )
            """)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=10000")
        return db

    def reserve(self, key: str, comment: str, request: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT * FROM order_intents WHERE idempotency_key=?", (key,)).fetchone()
                if row:
                    db.execute("COMMIT")
                    return False, dict(row)
                now = datetime.now(timezone.utc).isoformat()
                db.execute(
                    "INSERT INTO order_intents(idempotency_key,status,comment,request_json,updated_at) VALUES(?,?,?,?,?)",
                    (key, "SUBMITTING", comment, json.dumps(request, separators=(",", ":"), sort_keys=True), now),
                )
                row = db.execute("SELECT * FROM order_intents WHERE idempotency_key=?", (key,)).fetchone()
                db.execute("COMMIT")
                return True, dict(row)
            except Exception:
                db.execute("ROLLBACK")
                raise

    def update(self, key: str, status: str, result: dict[str, Any]) -> None:
        with self._lock, self._connect() as db:
            db.execute(
                "UPDATE order_intents SET status=?,result_json=?,updated_at=? WHERE idempotency_key=?",
                (status, json.dumps(result, separators=(",", ":"), sort_keys=True), datetime.now(timezone.utc).isoformat(), key),
            )

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM order_intents WHERE idempotency_key=?", (key,)).fetchone()
            return dict(row) if row else None


class BridgeService:
    def __init__(self, token: str, store: IdempotencyStore, symbol: str = DEFAULT_SYMBOL):
        self.token = token
        self.store = store
        self.symbol = symbol
        self._mt5_lock = threading.RLock()
        requested_environment = os.getenv("MT5_EXECUTION_ENVIRONMENT", "DEMO").strip().upper()
        self.execution_environment = requested_environment if requested_environment in ("DEMO", "LIVE") else "DEMO"
        self.live_enabled = (
            os.getenv("MT5_LIVE_TRADING_ENABLED", "").strip().lower() == "true"
            and os.getenv("MT5_LIVE_CONFIRMATION", "") == "I_UNDERSTAND_LIVE_TRADING_RISK"
        )
        if self.execution_environment == "LIVE" and not self.live_enabled:
            self.execution_environment = "DEMO"

    def _connect_mt5(self) -> tuple[bool, str]:
        if mt5 is None:
            return False, "MT5_PACKAGE_MISSING"
        try:
            path = os.getenv("MT5_TERMINAL_PATH")
            connected = mt5.initialize(path=path) if path else mt5.initialize()
            if not connected:
                return False, "MT5_INITIALIZE_FAILED"
            terminal = mt5.terminal_info()
            if terminal is None or not getattr(terminal, "connected", False):
                return False, "MT5_TERMINAL_DISCONNECTED"
            return True, "CONNECTED"
        except Exception:
            return False, "MT5_CONNECTION_ERROR"

    def health(self) -> dict[str, Any]:
        with self._mt5_lock:
            connected, reason = self._connect_mt5()
            if not connected:
                return {"state": "NOT_CONFIGURED" if reason == "MT5_PACKAGE_MISSING" else "DISCONNECTED", "reason": reason, "environment": self.execution_environment, "liveTradingEnabled": self.live_enabled}
            account = mt5.account_info()
            if account is None:
                return {"state": "DISCONNECTED", "reason": "ACCOUNT_INFO_UNAVAILABLE", "environment": self.execution_environment, "liveTradingEnabled": self.live_enabled}
            demo_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0)
            real_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2)
            actual_environment = "DEMO" if getattr(account, "trade_mode", None) == demo_mode else "LIVE" if getattr(account, "trade_mode", None) == real_mode else "BLOCKED"
            mode_matches = actual_environment == self.execution_environment
            live_allowed = actual_environment != "LIVE" or self.live_enabled
            hedging_mode = getattr(mt5, "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING", 2)
            is_hedging = getattr(account, "margin_mode", None) == hedging_mode
            execution_ready = mode_matches and live_allowed and is_hedging
            reason = ("DEMO_ACCOUNT_CONFIRMED" if actual_environment == "DEMO" else "LIVE_ACCOUNT_CONFIRMED") if execution_ready else "LIVE_DISABLED" if actual_environment == "LIVE" and not live_allowed else "EXECUTION_ENVIRONMENT_MISMATCH" if not mode_matches else "HEDGING_ACCOUNT_REQUIRED"
            return {
                "state": "CONNECTED" if execution_ready else "BLOCKED",
                "reason": reason,
                "environment": actual_environment,
                "accountMode": actual_environment,
                "accountLogin": str(getattr(account, "login", "")) if execution_ready else None,
                "executionReady": execution_ready,
                "liveTradingEnabled": self.live_enabled,
            }

    def quote(self) -> tuple[int, dict[str, Any]]:
        with self._mt5_lock:
            connected, reason = self._connect_mt5()
            if not connected:
                return 503, {"error": reason}
            if not mt5.symbol_select(self.symbol, True):
                return 503, {"error": "SYMBOL_SELECT_FAILED"}
            tick = mt5.symbol_info_tick(self.symbol)
            if tick is None or not math.isfinite(float(tick.bid)) or not math.isfinite(float(tick.ask)) or tick.bid <= 0 or tick.ask < tick.bid:
                return 503, {"error": "INVALID_TICK"}
            return 200, {"symbol": "XAUUSD", "bid": float(tick.bid), "ask": float(tick.ask), "tickTime": utc_iso(tick.time), "receivedAt": utc_iso(time.time())}

    def symbol_spec(self) -> tuple[int, dict[str, Any]]:
        with self._mt5_lock:
            connected, reason = self._connect_mt5()
            if not connected:
                return 503, {"error": reason}
            if not mt5.symbol_select(self.symbol, True):
                return 503, {"error": "SYMBOL_SELECT_FAILED"}
            info = mt5.symbol_info(self.symbol)
            if info is None:
                return 503, {"error": "SYMBOL_INFO_UNAVAILABLE"}
            tick_size = float(getattr(info, "trade_tick_size", 0) or 0)
            tick_value = float(getattr(info, "trade_tick_value", 0) or 0)
            point = float(getattr(info, "point", 0) or 0)
            volume_min, volume_max, volume_step = float(info.volume_min), float(info.volume_max), float(info.volume_step)
            stops_level = int(getattr(info, "trade_stops_level", 0) or 0)
            if (not all(math.isfinite(value) for value in (tick_size,tick_value,point,volume_min,volume_max,volume_step))
                    or tick_size <= 0 or tick_value <= 0 or point <= 0 or volume_min <= 0 or volume_max < volume_min or volume_step <= 0):
                return 503, {"error": "TICK_SPEC_UNAVAILABLE"}
            return 200, {
                "symbol": "XAUUSD", "tickSize": tick_size, "tickValuePerLot": tick_value,
                "volumeMin": volume_min, "volumeMax": volume_max,
                "volumeStep": volume_step, "priceDigits": int(info.digits),
                "point": point, "stopsLevelPoints": stops_level,
            }

    def candles(self, timeframe: str, count: int) -> tuple[int, dict[str, Any]]:
        if timeframe not in TIMEFRAME_MAP or isinstance(count, bool) or not isinstance(count, int) or count < 35 or count > 5000:
            return 400, {"error": "INVALID_CANDLE_REQUEST"}
        with self._mt5_lock:
            connected, reason = self._connect_mt5()
            if not connected:
                return 503, {"error": reason}
            if not mt5.symbol_select(self.symbol, True):
                return 503, {"error": "SYMBOL_SELECT_FAILED"}
            constant_name, seconds = TIMEFRAME_MAP[timeframe]
            constant = getattr(mt5, constant_name, None)
            if constant is None:
                return 503, {"error": "TIMEFRAME_UNAVAILABLE"}
            # Start at position 1: position 0 is the currently forming candle.
            rates = mt5.copy_rates_from_pos(self.symbol, constant, 1, count)
            if rates is None or len(rates) < 35:
                return 503, {"error": "INSUFFICIENT_CLOSED_HISTORY", "available": 0 if rates is None else len(rates)}
            result = []
            for row in rates:
                prices = [float(row[name]) for name in ("open", "high", "low", "close")]
                if not all(math.isfinite(price) and price > 0 for price in prices):
                    return 503, {"error": "INVALID_CANDLE_DATA"}
                opened = int(row["time"])
                if prices[1] < max(prices[0], prices[3], prices[2]) or prices[2] > min(prices[0], prices[3], prices[1]):
                    return 503, {"error": "INVALID_CANDLE_DATA"}
                result.append({
                    "symbol": "XAUUSD", "timeframe": timeframe, "openTime": utc_iso(opened),
                    "closeTime": utc_iso(opened + seconds), "open": float(row["open"]),
                    "high": float(row["high"]), "low": float(row["low"]), "close": float(row["close"]),
                    "tickVolume": int(row["tick_volume"]), "isClosed": True,
                })
            return 200, {"symbol": "XAUUSD", "timeframe": timeframe, "candles": result}

    def _account_matches_environment(self, expected_environment: str | None = None) -> tuple[bool, str]:
        connected, reason = self._connect_mt5()
        if not connected:
            return False, reason
        account = mt5.account_info()
        if account is None:
            return False, "ACCOUNT_INFO_UNAVAILABLE"
        demo_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0)
        real_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2)
        actual = "DEMO" if getattr(account, "trade_mode", None) == demo_mode else "LIVE" if getattr(account, "trade_mode", None) == real_mode else "BLOCKED"
        expected = expected_environment or self.execution_environment
        if actual != expected:
            return False, "EXECUTION_ENVIRONMENT_MISMATCH"
        if actual == "LIVE" and not self.live_enabled:
            return False, "LIVE_DISABLED"
        if getattr(account, "margin_mode", None) != getattr(mt5, "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING", 2):
            return False, "HEDGING_ACCOUNT_REQUIRED"
        return True, actual + "_ACCOUNT_CONFIRMED"

    def submit_order(self, payload: Any) -> tuple[int, dict[str, Any]]:
        valid, reason = validate_order_payload(payload, self.symbol)
        if not valid:
            return 400 if reason != "LIVE_DISABLED" else 403, {"state": "REJECTED", "error": reason}
        key = payload["idempotencyKey"]
        comment = stable_order_comment(key)
        with self._mt5_lock:
            allowed, account_reason = self._account_matches_environment()
            if not allowed:
                return 403 if account_reason == "NON_DEMO_ACCOUNT_BLOCKED" else 503, {"state": "REJECTED", "error": account_reason}
            if payload.get("symbol") != "XAUUSD" or not mt5.symbol_select(self.symbol, True):
                return 503, {"state": "REJECTED", "error": "SYMBOL_SELECT_FAILED"}
            info = mt5.symbol_info(self.symbol)
            tick = mt5.symbol_info_tick(self.symbol)
            if info is None or tick is None:
                return 503, {"state": "REJECTED", "error": "SYMBOL_INFO_UNAVAILABLE"}
            volume = float(payload["volume"])
            minimum, maximum, step = float(info.volume_min), float(info.volume_max), float(info.volume_step)
            if not all(math.isfinite(value) for value in (minimum, maximum, step)) or volume < minimum or volume > maximum or step <= 0:
                return 400, {"state": "REJECTED", "error": "VOLUME_OUTSIDE_BROKER_LIMITS"}
            steps = volume / step
            if abs(steps - round(steps)) > 1e-7:
                return 400, {"state": "REJECTED", "error": "VOLUME_STEP_MISMATCH"}
            direction = payload["direction"]
            stop, target = float(payload["stopLoss"]), float(payload["takeProfit"])
            entry = float(tick.ask if direction == "BUY" else tick.bid)
            if direction == "BUY" and not (stop < entry < target):
                return 400, {"state": "REJECTED", "error": "INVALID_BUY_PROTECTION"}
            if direction == "SELL" and not (target < entry < stop):
                return 400, {"state": "REJECTED", "error": "INVALID_SELL_PROTECTION"}
            created, previous = self.store.reserve(key, comment, payload)
            if not created:
                status = previous["status"]
                if status in ("CONFIRMED", "REJECTED"):
                    return 200, json.loads(previous["result_json"] or "{}")
                return 409, {"state": "RECONCILIATION_REQUIRED", "error": "IDEMPOTENCY_KEY_ALREADY_RESERVED", "status": status}
            order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
            filling = getattr(mt5, "ORDER_FILLING_IOC", 1)
            request = {
                "action": mt5.TRADE_ACTION_DEAL, "symbol": self.symbol, "volume": volume,
                "type": order_type, "price": entry, "sl": stop, "tp": target,
                "deviation": int(os.getenv("MT5_DEVIATION_POINTS", "20")),
                "magic": 61016001, "comment": comment, "type_time": mt5.ORDER_TIME_GTC, "type_filling": filling,
            }
            try:
                checked = mt5.order_check(request)
                if checked is None:
                    result = {"state": "REJECTED", "error": "ORDER_CHECK_UNAVAILABLE"}
                    self.store.update(key, "REJECTED", result)
                    return 503, result
                check_code = int(getattr(checked, "retcode", -1))
                if check_code not in (0, getattr(mt5, "TRADE_RETCODE_DONE", 10009)):
                    result = {"state": "REJECTED", "error": "ORDER_CHECK_REJECTED", "brokerCode": check_code}
                    self.store.update(key, "REJECTED", result)
                    return 422, result
                sent = mt5.order_send(request)
                if sent is None:
                    result = {"state": "UNKNOWN", "error": "ORDER_RESULT_UNKNOWN", "comment": comment}
                    self.store.update(key, "UNKNOWN", result)
                    return 202, {"state": "RECONCILIATION_REQUIRED", "comment": comment}
                retcode = int(getattr(sent, "retcode", -1))
                success_codes = {getattr(mt5, name, -99999) for name in SUCCESS_RET_CODES}
                if retcode in success_codes:
                    result = {"state": "CONFIRMED", "brokerOrderId": str(getattr(sent, "order", "") or getattr(sent, "deal", "")), "brokerCode": retcode, "comment": comment}
                    self.store.update(key, "CONFIRMED", result)
                    return 200, result
                result = {"state": "REJECTED", "error": "BROKER_REJECTED", "brokerCode": retcode, "comment": comment}
                self.store.update(key, "REJECTED", result)
                return 422, result
            except Exception:
                result = {"state": "UNKNOWN", "error": "SUBMISSION_RESULT_UNKNOWN", "comment": comment}
                self.store.update(key, "UNKNOWN", result)
                return 202, {"state": "RECONCILIATION_REQUIRED", "comment": comment}

    def positions(self) -> tuple[int, dict[str, Any]]:
        with self._mt5_lock:
            allowed, reason = self._account_is_demo()
            if not allowed:
                return 503 if reason != "NON_DEMO_ACCOUNT_BLOCKED" else 403, {"error": reason, "positions": []}
            positions = mt5.positions_get(symbol=self.symbol)
            if positions is None:
                return 503, {"error": "POSITIONS_UNAVAILABLE", "positions": []}
            visible_positions = []
            for position in positions:
                owned_by_bot = int(getattr(position, "magic", 0)) == 61016001 and str(getattr(position, "comment", "")).startswith("XAUAI-")
                visible_positions.append({
                    "ticket": int(position.ticket), "symbol": "XAUUSD",
                    "direction": "BUY" if int(position.type) == getattr(mt5, "POSITION_TYPE_BUY", 0) else "SELL",
                    "volume": float(position.volume), "entryPrice": float(position.price_open),
                    "stopLoss": float(position.sl), "takeProfit": float(position.tp),
                    "profit": float(position.profit), "openedAt": utc_iso(position.time),
                    "ownedByBot": owned_by_bot, "comment": str(position.comment) if owned_by_bot else ""
                })
            account = mt5.account_info()
            return 200, {"positions": visible_positions, "environment": self.execution_environment, "accountLogin": str(getattr(account, "login", "")) if account is not None else None}

    def modify_position(self, payload: Any) -> tuple[int, dict[str, Any]]:
        if not isinstance(payload, dict) or isinstance(payload.get("ticket"), bool) or not isinstance(payload.get("ticket"), int):
            return 400, {"state": "REJECTED", "error": "INVALID_TICKET"}
        with self._mt5_lock:
            allowed, reason = self._account_is_demo()
            if not allowed:
                return 503 if reason != "NON_DEMO_ACCOUNT_BLOCKED" else 403, {"state": "REJECTED", "error": reason}
            matches = mt5.positions_get(ticket=payload["ticket"])
            if not matches:
                return 404, {"state": "REJECTED", "error": "POSITION_NOT_FOUND"}
            position = matches[0]
            if int(getattr(position, "magic", 0)) != 61016001 or not str(getattr(position, "comment", "")).startswith("XAUAI-"):
                return 403, {"state": "REJECTED", "error": "POSITION_NOT_OWNED_BY_BOT"}
            try:
                stop = float(payload.get("stopLoss", position.sl))
                target = float(payload.get("takeProfit", position.tp))
            except (TypeError, ValueError):
                return 400, {"state": "REJECTED", "error": "INVALID_PROTECTIVE_PRICE"}
            if not math.isfinite(stop) or not math.isfinite(target) or stop < 0 or target < 0:
                return 400, {"state": "REJECTED", "error": "INVALID_PROTECTIVE_PRICE"}
            if (float(position.sl) > 0 and stop <= 0) or (float(position.tp) > 0 and target <= 0):
                return 400, {"state": "REJECTED", "error": "CANNOT_REMOVE_EXISTING_PROTECTION"}
            tick = mt5.symbol_info_tick(self.symbol)
            if tick is None:
                return 503, {"state": "REJECTED", "error": "TICK_UNAVAILABLE"}
            is_buy = int(position.type) == getattr(mt5, "POSITION_TYPE_BUY", 0)
            if (is_buy and ((stop and stop >= tick.bid) or (target and target <= tick.bid))) or (not is_buy and ((stop and stop <= tick.ask) or (target and target >= tick.ask))):
                return 400, {"state": "REJECTED", "error": "INVALID_PROTECTIVE_DIRECTION"}
            request = {"action": mt5.TRADE_ACTION_SLTP, "symbol": self.symbol, "position": int(position.ticket), "sl": stop, "tp": target, "magic": 61016001, "comment": str(position.comment)}
            try:
                check = mt5.order_check(request)
                if check is None or int(getattr(check, "retcode", -1)) not in (0, getattr(mt5, "TRADE_RETCODE_DONE", 10009)):
                    return 422, {"state": "REJECTED", "error": "ORDER_CHECK_REJECTED"}
                result = mt5.order_send(request)
                if result is None:
                    return 202, {"state": "RECONCILIATION_REQUIRED", "error": "MODIFY_RESULT_UNKNOWN"}
                if int(getattr(result, "retcode", -1)) in {getattr(mt5, name, -99999) for name in SUCCESS_RET_CODES}:
                    return 200, {"state": "CONFIRMED", "ticket": int(position.ticket), "stopLoss": stop, "takeProfit": target}
                return 422, {"state": "REJECTED", "error": "BROKER_REJECTED", "brokerCode": int(getattr(result, "retcode", -1))}
            except Exception:
                return 202, {"state": "RECONCILIATION_REQUIRED", "error": "MODIFY_RESULT_UNKNOWN"}

    def close_position(self, payload: Any) -> tuple[int, dict[str, Any]]:
        if not isinstance(payload, dict) or isinstance(payload.get("ticket"), bool) or not isinstance(payload.get("ticket"), int):
            return 400, {"state": "REJECTED", "error": "INVALID_TICKET"}
        key = payload.get("idempotencyKey")
        if not isinstance(key, str) or not key.strip() or len(key) > 180:
            return 400, {"state": "REJECTED", "error": "INVALID_IDEMPOTENCY_KEY"}
        with self._mt5_lock:
            previous = self.store.get(key)
            if previous:
                if previous["status"] in ("CONFIRMED", "REJECTED"):
                    return 200, json.loads(previous["result_json"] or "{}")
                return 409, {"state": "RECONCILIATION_REQUIRED", "error": "CLOSE_RESULT_MAY_BE_AMBIGUOUS"}
            allowed, reason = self._account_is_demo()
            if not allowed:
                return 503 if reason != "NON_DEMO_ACCOUNT_BLOCKED" else 403, {"state": "REJECTED", "error": reason}
            matches = mt5.positions_get(ticket=payload["ticket"])
            if not matches:
                return 404, {"state": "REJECTED", "error": "POSITION_NOT_FOUND"}
            position = matches[0]
            if int(getattr(position, "magic", 0)) != 61016001 or not str(getattr(position, "comment", "")).startswith("XAUAI-"):
                return 403, {"state": "REJECTED", "error": "POSITION_NOT_OWNED_BY_BOT"}
            comment = stable_order_comment(key)
            created, previous = self.store.reserve(key, comment, payload)
            if not created:
                if previous["status"] in ("CONFIRMED", "REJECTED"):
                    return 200, json.loads(previous["result_json"] or "{}")
                return 409, {"state": "RECONCILIATION_REQUIRED", "error": "CLOSE_RESULT_MAY_BE_AMBIGUOUS"}
            tick = mt5.symbol_info_tick(self.symbol)
            if tick is None:
                result = {"state": "REJECTED", "error": "TICK_UNAVAILABLE"}
                self.store.update(key, "REJECTED", result)
                return 503, result
            is_buy = int(position.type) == getattr(mt5, "POSITION_TYPE_BUY", 0)
            request = {
                "action": mt5.TRADE_ACTION_DEAL, "symbol": self.symbol, "position": int(position.ticket),
                "volume": float(position.volume),
                "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
                "price": float(tick.bid if is_buy else tick.ask),
                "deviation": int(os.getenv("MT5_DEVIATION_POINTS", "20")),
                "magic": 61016001, "comment": comment, "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": getattr(mt5, "ORDER_FILLING_IOC", 1),
            }
            try:
                check = mt5.order_check(request)
                if check is None or int(getattr(check, "retcode", -1)) not in (0, getattr(mt5, "TRADE_RETCODE_DONE", 10009)):
                    result = {"state": "REJECTED", "error": "ORDER_CHECK_REJECTED"}
                    self.store.update(key, "REJECTED", result)
                    return 422, result
                result = mt5.order_send(request)
                if result is None:
                    uncertain = {"state": "UNKNOWN", "error": "CLOSE_RESULT_UNKNOWN", "comment": comment}
                    self.store.update(key, "UNKNOWN", uncertain)
                    return 202, {"state": "RECONCILIATION_REQUIRED", "comment": comment}
                code = int(getattr(result, "retcode", -1))
                if code in {getattr(mt5, name, -99999) for name in SUCCESS_RET_CODES}:
                    confirmed = {"state": "CONFIRMED", "ticket": int(position.ticket), "brokerOrderId": str(getattr(result, "order", "") or getattr(result, "deal", "")), "comment": comment}
                    self.store.update(key, "CONFIRMED", confirmed)
                    return 200, confirmed
                rejected = {"state": "REJECTED", "error": "BROKER_REJECTED", "brokerCode": code, "comment": comment}
                self.store.update(key, "REJECTED", rejected)
                return 422, rejected
            except Exception:
                uncertain = {"state": "UNKNOWN", "error": "CLOSE_RESULT_UNKNOWN", "comment": comment}
                self.store.update(key, "UNKNOWN", uncertain)
                return 202, {"state": "RECONCILIATION_REQUIRED", "comment": comment}

    def lookup_intent(self, key: str) -> tuple[int, dict[str, Any]]:
        if not key or len(key) > 180:
            return 400, {"error": "INVALID_IDEMPOTENCY_KEY"}
        row = self.store.get(key)
        if row is None:
            return 404, {"state": "NOT_FOUND", "error": "NOT_FOUND"}
        if row["status"] in ("SUBMITTING", "UNKNOWN"):
            return 202, {"state": "RECONCILIATION_REQUIRED", "comment": row["comment"]}
        return 200, json.loads(row["result_json"] or "{}")


def create_handler(service: BridgeService):
    class Handler(BaseHTTPRequestHandler):
        server_version = "XAUUSD-MT5-Bridge"
        def log_message(self, fmt: str, *args: Any) -> None:
            # Do not log request paths, query parameters, authorization headers or credentials.
            return None

        def _send(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            supplied = self.headers.get("X-Bridge-Token", "")
            return bool(service.token) and hmac.compare_digest(supplied, service.token)

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if not self._authorized():
                return self._send(401, {"error": "UNAUTHORIZED"})
            if parsed.path == "/health":
                return self._send(200, service.health())
            if parsed.path == "/market/quote":
                status, body = service.quote()
                return self._send(status, body)
            if parsed.path == "/market/spec":
                status, body = service.symbol_spec()
                return self._send(status, body)
            if parsed.path == "/positions":
                status, body = service.positions()
                return self._send(status, body)
            if parsed.path == "/market/candles":
                query = parse_qs(parsed.query)
                timeframe = query.get("timeframe", ["M1"])[0]
                try: count = int(query.get("count", ["200"])[0])
                except ValueError: count = 0
                status, body = service.candles(timeframe, count)
                return self._send(status, body)
            if parsed.path == "/orders/lookup":
                key = parse_qs(parsed.query).get("idempotencyKey", [""])[0]
                status, body = service.lookup_intent(key)
                return self._send(status, body)
            return self._send(404, {"error": "NOT_FOUND"})

        def do_POST(self) -> None:
            if not self._authorized():
                return self._send(401, {"error": "UNAUTHORIZED"})
            route = urlparse(self.path).path
            if route not in ("/orders", "/positions/modify", "/positions/close"):
                return self._send(404, {"error": "NOT_FOUND"})
            try:
                length = int(self.headers.get("content-length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    return self._send(413, {"error": "INVALID_BODY_SIZE"})
                payload = json.loads(self.rfile.read(length))
            except (ValueError, json.JSONDecodeError):
                return self._send(400, {"error": "INVALID_JSON"})
            if route == "/orders":
                status, body = service.submit_order(payload)
            elif route == "/positions/modify":
                status, body = service.modify_position(payload)
            else:
                status, body = service.close_position(payload)
            return self._send(status, body)

        def do_PUT(self) -> None:
            return self._send(405, {"error": "METHOD_NOT_ALLOWED"})

    return Handler


def main() -> None:
    token = os.getenv("MT5_BRIDGE_TOKEN", "").strip()
    if not token:
        raise SystemExit("MT5_BRIDGE_TOKEN is required; refusing to start without bridge authentication.")
    host = os.getenv("MT5_BRIDGE_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Remote binding is disabled. Keep the MT5 bridge on loopback and use a secured local deployment.")
    port = int(os.getenv("MT5_BRIDGE_PORT", "8765"))
    db_path = os.getenv("MT5_BRIDGE_DB", str(ROOT / "state.sqlite3"))
    service = BridgeService(token, IdempotencyStore(db_path))
    server = ThreadingHTTPServer((host, port), create_handler(service))
    print(f"MT5 bridge listening on {host}:{port}; execution environment={service.execution_environment}; live enabled={service.live_enabled}.")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if mt5 is not None:
            try: mt5.shutdown()
            except Exception: pass


if __name__ == "__main__":
    main()
