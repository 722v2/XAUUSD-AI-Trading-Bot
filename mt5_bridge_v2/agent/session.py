from __future__ import annotations
from typing import Any

class MT5Session:
    def __init__(self, mt5: Any, terminal_path: str | None, environment: str = "DEMO"):
        self.mt5=mt5; self.terminal_path=terminal_path; self.environment=environment
    def _expected_trade_mode(self):
        name = "ACCOUNT_TRADE_MODE_REAL" if self.environment == "LIVE" else "ACCOUNT_TRADE_MODE_DEMO"
        return getattr(self.mt5, name, None)
    def _account_matches(self, account):
        expected = self._expected_trade_mode()
        return account is not None and expected is not None and getattr(account, "trade_mode", None) == expected
    def connect(self) -> tuple[bool,str]:
        if self.mt5 is None: return False,"MT5_PACKAGE_MISSING"
        try:
            # Keep a healthy terminal initialized; retry initialization after disconnects.
            terminal=self.mt5.terminal_info()
            account=self.mt5.account_info()
            if terminal and getattr(terminal,"connected",False) and account:
                if not self._account_matches(account):
                    return False,"LIVE_ACCOUNT_REQUIRED" if self.environment == "LIVE" else "DEMO_ACCOUNT_REQUIRED"
                return True,"CONNECTED"
            ok=self.mt5.initialize(path=self.terminal_path) if self.terminal_path else self.mt5.initialize()
            if not ok: return False,"MT5_INITIALIZE_FAILED"
            terminal=self.mt5.terminal_info()
            account=self.mt5.account_info()
            if not terminal or not getattr(terminal,"connected",False): return False,"MT5_TERMINAL_DISCONNECTED"
            if not account: return False,"MT5_ACCOUNT_INFO_UNAVAILABLE"
            if not self._account_matches(account): return False,"LIVE_ACCOUNT_REQUIRED" if self.environment == "LIVE" else "DEMO_ACCOUNT_REQUIRED"
            return True,"CONNECTED"
        except Exception: return False,"MT5_SESSION_ERROR"
    def close(self):
        try:
            if self.mt5 is not None: self.mt5.shutdown()
        except Exception: pass
