from __future__ import annotations
from datetime import datetime, timezone
from typing import Any

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")

def snapshot(mt5: Any, symbol: str, environment: str, last_error: str | None) -> dict:
    if mt5 is None:
        return {"state":"DISCONNECTED","terminalConnected":False,"accountConnected":False,"executionReady":False,"environment":environment,"brokerSymbol":None,"lastErrorCode":"MT5_PACKAGE_MISSING","sentAt":utc_now()}
    try:
        terminal=mt5.terminal_info()
        account=mt5.account_info()
        terminal_ok=bool(terminal and getattr(terminal,"connected",False))
        account_ok=bool(account and getattr(account,"login",None))
        selected=None
        if terminal_ok and account_ok:
            names=[getattr(x,"name","") for x in (mt5.symbols_get() or [])]
            selected=next((n for n in names if str(n).upper()=="XAUUSD.M"),None) or next((n for n in names if str(n).upper()=="XAUUSD"),None)
            if selected: mt5.symbol_select(selected,True)
        mode=getattr(account,"trade_mode",None) if account else None
        demo_mode=getattr(mt5,"ACCOUNT_TRADE_MODE_DEMO",0)
        is_demo=account_ok and mode==demo_mode
        ready=bool(terminal_ok and account_ok and selected and is_demo)
        tick=mt5.symbol_info_tick(selected) if selected else None
        quote={"bid":float(tick.bid),"ask":float(tick.ask),"tickTime":utc_now()} if tick and getattr(tick,"bid",0)>0 and getattr(tick,"ask",0)>0 else None
        spec={"volumeMin":float(getattr(mt5.symbol_info(selected),"volume_min",0)),"volumeMax":float(getattr(mt5.symbol_info(selected),"volume_max",0)),"volumeStep":float(getattr(mt5.symbol_info(selected),"volume_step",0)),"digits":int(getattr(mt5.symbol_info(selected),"digits",2)),"point":float(getattr(mt5.symbol_info(selected),"point",0)),"stopsLevelPoints":int(getattr(mt5.symbol_info(selected),"trade_stops_level",0))} if selected and mt5.symbol_info(selected) else None
        return {"state":"CONNECTED" if ready else "DEGRADED","terminalConnected":terminal_ok,"accountConnected":account_ok,"executionReady":bool(ready and quote and spec),"environment":"DEMO","brokerSymbol":selected,"accountLogin":str(getattr(account,"login","")) if account_ok else None,"quote":quote,"symbolSpec":spec,"lastErrorCode":None if ready and quote and spec else (last_error or ("MARKET_INFO_UNAVAILABLE" if ready else "NOT_DEMO_ACCOUNT" if account_ok and not is_demo else "MT5_NOT_READY")),"sentAt":utc_now()}
    except Exception:
        return {"state":"DISCONNECTED","terminalConnected":False,"accountConnected":False,"executionReady":False,"environment":"DEMO","brokerSymbol":None,"lastErrorCode":"MT5_HEALTH_CHECK_FAILED","sentAt":utc_now()}
