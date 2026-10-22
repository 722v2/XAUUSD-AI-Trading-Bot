from __future__ import annotations
from typing import Any

class MT5Session:
    def __init__(self, mt5: Any, terminal_path: str | None):
        self.mt5=mt5; self.terminal_path=terminal_path
    def connect(self) -> tuple[bool,str]:
        if self.mt5 is None: return False,"MT5_PACKAGE_MISSING"
        try:
            ok=self.mt5.initialize(path=self.terminal_path) if self.terminal_path else self.mt5.initialize()
            if not ok: return False,"MT5_INITIALIZE_FAILED"
            terminal=self.mt5.terminal_info()
            account=self.mt5.account_info()
            if not terminal or not getattr(terminal,"connected",False): return False,"MT5_TERMINAL_DISCONNECTED"
            if not account: return False,"MT5_ACCOUNT_INFO_UNAVAILABLE"
            if getattr(account,"trade_mode",None)!=getattr(self.mt5,"ACCOUNT_TRADE_MODE_DEMO",0): return False,"DEMO_ACCOUNT_REQUIRED"
            return True,"CONNECTED"
        except Exception: return False,"MT5_SESSION_ERROR"
    def close(self):
        try:
            if self.mt5 is not None: self.mt5.shutdown()
        except Exception: pass
