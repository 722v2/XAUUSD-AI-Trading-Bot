from __future__ import annotations
import hashlib
import math
from datetime import datetime, timedelta, timezone
from typing import Any
from .outbox import Outbox
from .health import utc_now

def _finite_positive(value: Any) -> bool:
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and value>0

class OrderExecutor:
    """Demo-only market order executor. Persists SUBMITTING before broker I/O; uncertain results are never retried."""
    def __init__(self,mt5: Any,outbox: Outbox,symbol: str="XAUUSD"):
        self.mt5=mt5;self.outbox=outbox;self.symbol=symbol
    def execute(self,command: dict) -> dict:
        command_id=command["id"]; key=command["idempotencyKey"]; payload=command.get("payload")
        def result(state,code,details=None):
            return {"commandId":command_id,"idempotencyKey":key,"state":state,"code":code,"details":details or {},"completedAt":utc_now()}
        prior=self.outbox.command_state(key)
        if prior:
            return result("UNKNOWN" if prior["state"] in ("SUBMITTING","UNKNOWN") else "REJECTED","DUPLICATE_IDEMPOTENCY_KEY",{"previousState":prior["state"],"automaticRetry":False})
        if not isinstance(payload,dict) or command.get("environment")!="DEMO":
            return result("REJECTED","DEMO_ONLY_OR_INVALID_PAYLOAD")
        if self.mt5 is None: return result("REJECTED","MT5_PACKAGE_MISSING")
        direction=payload.get("direction")
        volume=payload.get("volume"); sl=payload.get("stopLoss"); tp=payload.get("takeProfit")
        symbol=payload.get("symbol","XAUUSD")
        if direction not in ("BUY","SELL") or symbol!="XAUUSD" or not all(_finite_positive(x) for x in (volume,sl,tp)):
            return result("REJECTED","INVALID_ORDER_FIELDS")
        if volume>100: return result("REJECTED","VOLUME_LIMIT_EXCEEDED")
        try:
            names=[getattr(x,"name","") for x in (self.mt5.symbols_get() or [])]
            broker_symbol=next((n for n in names if str(n).upper()=="XAUUSD.M"),None) or next((n for n in names if str(n).upper()=="XAUUSD"),None)
            if not broker_symbol or not self.mt5.symbol_select(broker_symbol,True): return result("REJECTED","GOLD_SYMBOL_UNAVAILABLE")
            info=self.mt5.symbol_info(broker_symbol); tick=self.mt5.symbol_info_tick(broker_symbol); account=self.mt5.account_info()
            if not info or not tick or not account: return result("REJECTED","BROKER_MARKET_STATE_UNAVAILABLE")
            if getattr(account,"trade_mode",None)!=getattr(self.mt5,"ACCOUNT_TRADE_MODE_DEMO",0): return result("REJECTED","DEMO_ACCOUNT_REQUIRED")
            step=float(getattr(info,"volume_step",0)); vmin=float(getattr(info,"volume_min",0)); vmax=float(getattr(info,"volume_max",0))
            if step<=0 or vmin<=0 or vmax<=0 or volume<vmin or volume>vmax or abs(volume/step-round(volume/step))>1e-7:
                return result("REJECTED","INVALID_VOLUME_STEP")
            price=float(tick.ask if direction=="BUY" else tick.bid)
            digits=int(getattr(info,"digits",2)); point=float(getattr(info,"point",0))
            if point<=0: return result("REJECTED","INVALID_SYMBOL_POINT")
            if direction=="BUY" and not (sl<price<tp): return result("REJECTED","INVALID_BUY_SL_TP")
            if direction=="SELL" and not (tp<price<sl): return result("REJECTED","INVALID_SELL_SL_TP")
            stops=float(getattr(info,"trade_stops_level",0))*point
            if price-sl<stops or tp-price<stops if direction=="BUY" else sl-price<stops or price-tp<stops:
                return result("REJECTED","BROKER_STOPS_DISTANCE")
            digest=hashlib.sha256(key.encode()).hexdigest()[:16]
            comment="XAUAI-"+digest
            request={"action":getattr(self.mt5,"TRADE_ACTION_DEAL"),"symbol":broker_symbol,"volume":float(volume),
              "type":getattr(self.mt5,"ORDER_TYPE_BUY") if direction=="BUY" else getattr(self.mt5,"ORDER_TYPE_SELL"),
              "price":round(price,digits),"sl":round(float(sl),digits),"tp":round(float(tp),digits),
              "deviation":20,"magic":2601022,"comment":comment,"type_time":getattr(self.mt5,"ORDER_TIME_GTC"),
              "type_filling":getattr(self.mt5,"ORDER_FILLING_IOC",1)}
            check=self.mt5.order_check(request)
            if check is None: return result("REJECTED","ORDER_CHECK_NO_RESPONSE")
            done_code=getattr(self.mt5,"TRADE_RETCODE_DONE",10009)
            placed_code=getattr(self.mt5,"TRADE_RETCODE_PLACED",10008)
            if getattr(check,"retcode",None) not in (done_code,placed_code,0):
                return result("REJECTED","ORDER_CHECK_REJECTED",{"retcode":getattr(check,"retcode",None),"comment":str(getattr(check,"comment",""))[:200]})
            # Persist before the only broker submission attempt. If the process crashes after this point,
            # the same idempotency key is never automatically resubmitted.
            self.outbox.mark(key,"SUBMITTING",{"commandId":command_id,"idempotencyKey":key,"comment":comment,"request":request})
            sent=self.mt5.order_send(request)
            if sent is None:
                self.outbox.mark(key,"UNKNOWN",{"commandId":command_id,"idempotencyKey":key,"code":"ORDER_SEND_NO_RESPONSE","comment":comment})
                return result("UNKNOWN","ORDER_SEND_NO_RESPONSE",{"comment":comment,"reconcileRequired":True})
            retcode=getattr(sent,"retcode",None)
            if retcode in (done_code,getattr(self.mt5,"TRADE_RETCODE_DONE_PARTIAL",10010)):
                details={"brokerSymbol":broker_symbol,"order":getattr(sent,"order",None),"deal":getattr(sent,"deal",None),"volume":getattr(sent,"volume",volume),"price":getattr(sent,"price",price),"comment":comment}
                self.outbox.mark(key,"FILLED",details)
                return result("FILLED","BROKER_EXECUTION_CONFIRMED",details)
            if retcode==placed_code:
                details={"brokerSymbol":broker_symbol,"order":getattr(sent,"order",None),"comment":comment,"retcode":retcode}
                self.outbox.mark(key,"UNKNOWN",{"commandId":command_id,"idempotencyKey":key,**details})
                return result("UNKNOWN","ORDER_PLACED_NOT_FILLED",{"reconcileRequired":True,**details})
            details={"retcode":retcode,"comment":str(getattr(sent,"comment",""))[:200],"brokerSymbol":broker_symbol}
            self.outbox.mark(key,"REJECTED",details)
            return result("REJECTED","BROKER_REJECTED",details)
        except Exception as exc:
            self.outbox.mark(key,"UNKNOWN",{"commandId":command_id,"idempotencyKey":key,"code":"EXECUTION_EXCEPTION","exceptionType":type(exc).__name__})
            return result("UNKNOWN","EXECUTION_EXCEPTION",{"reconcileRequired":True})

    def reconcile_uncertain(self, key: str, saved: dict) -> dict | None:
        """Resolve only when broker history proves the matching deal; absence is never proof of non-execution."""
        if self.mt5 is None: return None
        comment=saved.get("comment") or (saved.get("details") or {}).get("comment")
        if not isinstance(comment,str) or not comment.startswith("XAUAI-"): return None
        try:
            end=datetime.now(timezone.utc)
            start=end-timedelta(days=7)
            deals=self.mt5.history_deals_get(start,end) or []
            matches=[d for d in deals if getattr(d,"comment",None)==comment and str(getattr(d,"symbol","")).upper().startswith("XAUUSD")]
            if matches:
                deal=matches[-1]
                details={"comment":comment,"deal":getattr(deal,"ticket",None),"order":getattr(deal,"order",None),"volume":getattr(deal,"volume",None),"price":getattr(deal,"price",None),"reconciledFromHistory":True}
                self.outbox.mark(key,"FILLED",details)
                return {"state":"FILLED","code":"BROKER_DEAL_FOUND_DURING_RECONCILIATION","details":details}
            orders=self.mt5.history_orders_get(start,end) or []
            matching=[o for o in orders if getattr(o,"comment",None)==comment and str(getattr(o,"symbol","")).upper().startswith("XAUUSD")]
            if matching:
                order=matching[-1]
                terminal_states={getattr(self.mt5,"ORDER_STATE_CANCELED",-100),getattr(self.mt5,"ORDER_STATE_REJECTED",-101),getattr(self.mt5,"ORDER_STATE_EXPIRED",-102)}
                state=getattr(order,"state",None)
                if state in terminal_states:
                    details={"comment":comment,"order":getattr(order,"ticket",None),"brokerState":state,"reconciledFromHistory":True}
                    self.outbox.mark(key,"REJECTED",details)
                    return {"state":"REJECTED","code":"BROKER_ORDER_TERMINAL_WITHOUT_FILL","details":details}
            return None
        except Exception:
            return None
