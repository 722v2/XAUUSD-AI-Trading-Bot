from __future__ import annotations
from datetime import datetime, time as dt_time, timedelta, timezone
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
            names=[str(getattr(x,"name","")) for x in (mt5.symbols_get() or [])]
            configured=symbol.strip()
            selected=next((n for n in names if n.upper()==configured.upper()),None)
            if selected is None and configured.upper()=="XAUUSD":
                selected=next((n for n in names if n.upper()=="XAUUSD"),None) or next((n for n in names if n.upper().startswith("XAUUSD.")),None)
            if selected: mt5.symbol_select(selected,True)
        mode=getattr(account,"trade_mode",None) if account else None
        demo_mode=getattr(mt5,"ACCOUNT_TRADE_MODE_DEMO",0)
        is_demo=account_ok and mode==demo_mode
        ready=bool(terminal_ok and account_ok and selected and is_demo)
        tick=mt5.symbol_info_tick(selected) if selected else None
        quote={"bid":float(tick.bid),"ask":float(tick.ask),"tickTime":utc_now()} if tick and getattr(tick,"bid",0)>0 and getattr(tick,"ask",0)>0 else None
        spec={"volumeMin":float(getattr(mt5.symbol_info(selected),"volume_min",0)),"volumeMax":float(getattr(mt5.symbol_info(selected),"volume_max",0)),"volumeStep":float(getattr(mt5.symbol_info(selected),"volume_step",0)),"digits":int(getattr(mt5.symbol_info(selected),"digits",2)),"point":float(getattr(mt5.symbol_info(selected),"point",0)),"tickSize":float(getattr(mt5.symbol_info(selected),"trade_tick_size",getattr(mt5.symbol_info(selected),"point",0))),"tickValuePerLot":float(getattr(mt5.symbol_info(selected),"trade_tick_value",0)),"stopsLevelPoints":int(getattr(mt5.symbol_info(selected),"trade_stops_level",0))} if selected and mt5.symbol_info(selected) else None
        positions_snapshot=[]
        if selected and hasattr(mt5,"positions_get"):
            try:
                for position in (mt5.positions_get(symbol=selected) or []):
                    direction="BUY" if getattr(position,"type",None)==getattr(mt5,"POSITION_TYPE_BUY",0) else "SELL"
                    magic=getattr(position,"magic",None)
                    comment=str(getattr(position,"comment",""))
                    positions_snapshot.append({
                        "ticket":int(getattr(position,"ticket",0)),"symbol":"XAUUSD","direction":direction,
                        "volume":float(getattr(position,"volume",0)),"entryPrice":float(getattr(position,"price_open",0)),
                        "stopLoss":float(getattr(position,"sl",0)),"takeProfit":float(getattr(position,"tp",0)),
                        "profit":float(getattr(position,"profit",0)),
                        "openedAt":datetime.fromtimestamp(float(getattr(position,"time",0)),timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"),
                        "ownedByBot":magic==2601022 or comment.startswith("XAUAI-"),"comment":comment
                    })
            except Exception:
                positions_snapshot=[]
        daily_risk=None
        if account_ok and hasattr(mt5,"history_deals_get"):
            try:
                now=datetime.now(timezone.utc)
                day_start=datetime.combine(now.date(),dt_time.min,tzinfo=timezone.utc)
                history_start=now-timedelta(days=30)
                deals=mt5.history_deals_get(history_start,now)
                if deals is not None:
                    close_entries={getattr(mt5,"DEAL_ENTRY_OUT",1),getattr(mt5,"DEAL_ENTRY_OUT_BY",3),getattr(mt5,"DEAL_ENTRY_INOUT",2)}
                    closed=[]
                    daily_net_pnl=0.0
                    for deal in deals:
                        if getattr(deal,"magic",None)!=2601022 or getattr(deal,"entry",None) not in close_entries:
                            continue
                        stamp=int(getattr(deal,"time",0))
                        pnl=sum(float(getattr(deal,name,0) or 0) for name in ("profit","commission","swap","fee"))
                        closed.append((stamp,int(getattr(deal,"position_id",getattr(deal,"ticket",0))),pnl))
                        if stamp>=int(day_start.timestamp()):
                            daily_net_pnl+=pnl
                    by_position={}
                    for stamp,position_id,pnl in closed:
                        item=by_position.setdefault(position_id,{"time":stamp,"pnl":0.0})
                        item["time"]=max(item["time"],stamp);item["pnl"]+=pnl
                    ordered=sorted(by_position.values(),key=lambda item:item["time"])
                    consecutive=0
                    for item in reversed(ordered):
                        if item["pnl"]<0: consecutive+=1
                        else: break
                    daily_risk={"accountLogin":str(getattr(account,"login","")),"currency":str(getattr(account,"currency","")),"balance":float(getattr(account,"balance",0)),"dailyNetPnl":daily_net_pnl,"consecutiveLosses":consecutive,"asOf":utc_now(),"dayStartUtc":day_start.isoformat(timespec="milliseconds").replace("+00:00","Z"),"source":"MT5_CLOSED_DEALS_BOT_MAGIC"}
            except Exception:
                daily_risk=None
        return {"state":"CONNECTED" if ready else "DEGRADED","terminalConnected":terminal_ok,"accountConnected":account_ok,"executionReady":bool(ready and quote and spec),"environment":"DEMO","brokerSymbol":selected,"accountLogin":str(getattr(account,"login","")) if account_ok else None,"quote":quote,"symbolSpec":spec,"positions":positions_snapshot,"dailyRisk":daily_risk,"lastErrorCode":None if ready and quote and spec else (last_error or ("MARKET_INFO_UNAVAILABLE" if ready else "NOT_DEMO_ACCOUNT" if account_ok and not is_demo else "MT5_NOT_READY")),"sentAt":utc_now()}
    except Exception:
        return {"state":"DISCONNECTED","terminalConnected":False,"accountConnected":False,"executionReady":False,"environment":"DEMO","brokerSymbol":None,"lastErrorCode":"MT5_HEALTH_CHECK_FAILED","sentAt":utc_now()}
