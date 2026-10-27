from __future__ import annotations
import json, sys, time, threading
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import load_config
from .outbox import Outbox
from .session import MT5Session
from .health import snapshot, utc_now
from .order_executor import OrderExecutor

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5=None

class Agent:
    def __init__(self):
        self.config=load_config()
        self.outbox=Outbox(self.config.database_path)
        self.session=MT5Session(mt5,self.config.terminal_path,self.config.environment)
        self.executor=OrderExecutor(mt5,self.outbox,self.config.symbol,self.config.environment,self.config.live_trading_enabled)
        self.last_error="STARTING"
        self.stop=threading.Event()
        self.lock=threading.RLock()
    def request(self,path,method="GET",payload=None,timeout=15):
        raw=None if payload is None else json.dumps(payload,separators=(",",":")).encode()
        req=Request(self.config.server_url+path,data=raw,method=method,headers={"X-Bridge-Token":self.config.token,"X-Agent-Id":self.config.agent_id,"Accept":"application/json","Content-Type":"application/json","User-Agent":"XAUUSD-MT5-Bridge/2.0"})
        try:
            with urlopen(req,timeout=timeout) as resp:
                data=resp.read(1_048_576)
                return resp.status, json.loads(data.decode()) if data else {}
        except HTTPError as exc:
            try: body=json.loads(exc.read(65536).decode())
            except Exception: body={"error":"INVALID_ERROR_RESPONSE"}
            return exc.code,body
        except (URLError,TimeoutError,OSError) as exc:
            self.last_error="RENDER_TRANSPORT_ERROR"
            print(f"[transport] {type(exc).__name__}; retrying",flush=True)
            return 503,{"error":self.last_error}
    def ensure_session(self):
        # Retry after terminal restarts or broker disconnects.
        with self.lock:
            ok,reason=self.session.connect()
            if ok:
                if self.last_error not in (None,"STARTING"): print("[health] MT5 session recovered",flush=True)
                self.last_error=None
                return True
            if self.last_error!=reason: print(f"[health] MT5 session unavailable: {reason}; will retry",flush=True)
            self.last_error=reason
            return False
    def heartbeat(self):
        self.ensure_session()
        state=snapshot(mt5,self.config.symbol,self.config.environment,self.last_error)
        state["agentId"]=self.config.agent_id
        status,body=self.request("/api/bridge/v1/heartbeat","POST",state,timeout=8)
        if status==200:
            if state["executionReady"]:
                self.last_error=None
                print(f"[health] connected; environment={self.config.environment}; symbol={state['brokerSymbol']}; live_trading_enabled={self.config.live_trading_enabled}; heartbeat accepted",flush=True)
            else:
                self.last_error=state.get("lastErrorCode") or self.last_error or "MT5_NOT_READY"
                print(f"[health] not ready: {state['lastErrorCode']}; heartbeat accepted",flush=True)
        else: print(f"[health] heartbeat rejected: HTTP {status} {body.get('error','HTTP_ERROR')}",flush=True)
    def market_data_sync(self):
        if mt5 is None or not self.ensure_session():
            return
        state=snapshot(mt5,self.config.symbol,self.config.environment,self.last_error)
        symbol=state.get("brokerSymbol")
        if not symbol:
            return
        frames={
            "M1":(getattr(mt5,"TIMEFRAME_M1",None),60,120),
            "M5":(getattr(mt5,"TIMEFRAME_M5",None),300,60),
            "M15":(getattr(mt5,"TIMEFRAME_M15",None),900,60),
            "H1":(getattr(mt5,"TIMEFRAME_H1",None),3600,60),
        }
        now=time.time()
        for timeframe,(constant,duration,count) in frames.items():
            if constant is None:
                continue
            try:
                rates=mt5.copy_rates_from_pos(symbol,constant,1,count)
                if rates is None:
                    continue
                candles=[]
                for row in rates:
                    opened=int(row["time"])
                    closed=opened+duration
                    if closed>now:
                        continue
                    values={name:float(row[name]) for name in ("open","high","low","close")}
                    volume=max(0,int(row["tick_volume"]))
                    if not all(value>0 and value<float("inf") for value in values.values()):
                        continue
                    candles.append({
                        "symbol":"XAUUSD","timeframe":timeframe,
                        "openTime":datetime.fromtimestamp(opened,timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"),
                        "closeTime":datetime.fromtimestamp(closed,timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"),
                        **values,"tickVolume":volume,"isClosed":True,
                    })
                candles.sort(key=lambda bar:bar["openTime"])
                if len(candles)<35:
                    print(f"[market-data] {timeframe}: insufficient closed bars ({len(candles)})",flush=True)
                    continue
                status,body=self.request("/api/bridge/v1/market/candles","POST",{
                    "agentId":self.config.agent_id,"timeframe":timeframe,"candles":candles[-count:]
                },timeout=8)
                if status==200:
                    print(f"[market-data] {timeframe}: published {body.get('acceptedBars',0)} closed bars",flush=True)
                else:
                    print(f"[market-data] {timeframe}: publish rejected HTTP {status} {body.get('error','HTTP_ERROR')}",flush=True)
            except Exception as exc:
                print(f"[market-data] {timeframe}: {type(exc).__name__}",flush=True)
    def market_data_loop(self):
        while not self.stop.is_set():
            try:
                self.market_data_sync()
            except Exception as exc:
                print(f"[market-data] sync failed: {type(exc).__name__}",flush=True)
            self.stop.wait(30.0)
    def flush_results(self):
        for row in self.outbox.pending_results():
            try: payload=json.loads(row["payload"])
            except Exception: continue
            status,body=self.request(f"/api/bridge/v1/commands/{row['command_id']}/result","POST",payload,timeout=8)
            if status==200: self.outbox.mark_delivered(row["command_id"])
            elif status not in (404,409): print(f"[outbox] result delivery pending: HTTP {status} {body.get('error','HTTP_ERROR')}",flush=True)
    def handle_command(self,command):
        if not isinstance(command,dict): return
        command_id=command.get("id"); key=command.get("idempotencyKey")
        if not isinstance(command_id,str) or not isinstance(key,str) or not key: return
        prior=self.outbox.command_state(key)
        if prior:
            if prior["state"] in ("SUBMITTING","UNKNOWN"):
                try: saved=json.loads(prior.get("result_json") or "{}")
                except Exception: saved={}
                details={"previousState":prior["state"],"automaticRetry":False}
                if isinstance(saved.get("comment"),str): details["comment"]=saved["comment"]
                if isinstance((saved.get("details") or {}).get("comment"),str): details["comment"]=saved["details"]["comment"]
                result={"commandId":command_id,"idempotencyKey":key,"state":"UNKNOWN","code":"RECOVERY_REQUIRES_RECONCILIATION","details":details,"completedAt":utc_now()}
                self.outbox.enqueue_result(command_id,key,"UNKNOWN",result)
            else:
                print(f"[command] duplicate key refused; state={prior['state']}",flush=True)
            return
        expires=command.get("expiresAt")
        try:
            if expires and datetime.fromisoformat(expires.replace("Z","+00:00")) < datetime.now(timezone.utc):
                result={"commandId":command_id,"idempotencyKey":key,"state":"EXPIRED","code":"COMMAND_EXPIRED","details":{},"completedAt":utc_now()}
                self.outbox.enqueue_result(command_id,key,"EXPIRED",result); return
        except ValueError:
            self.outbox.mark(key,"REJECTED",{"code":"INVALID_EXPIRY"}); return
        if command.get("kind")!="EXECUTE_ORDER" or command.get("environment")!=self.config.environment or (self.config.environment=="LIVE" and not self.config.live_trading_enabled):
            code="LIVE_TRADING_DISABLED" if self.config.environment=="LIVE" and not self.config.live_trading_enabled else "ENVIRONMENT_MISMATCH_OR_UNSUPPORTED_COMMAND"
            result={"commandId":command_id,"idempotencyKey":key,"state":"REJECTED","code":code,"details":{},"completedAt":utc_now()}
            self.outbox.enqueue_result(command_id,key,"REJECTED",result); return
        result=self.executor.execute(command)
        self.outbox.enqueue_result(command_id,key,result["state"],result)
    def recover_uncertain_commands(self):
        for row in self.outbox.unresolved():
            try: saved=json.loads(row["result_json"] or "{}")
            except Exception: continue
            reconciled=self.executor.reconcile_uncertain(row["idempotency_key"],saved)
            if not reconciled: continue
            command_id=saved.get("commandId")
            if not isinstance(command_id,str): continue
            payload={"commandId":command_id,"idempotencyKey":row["idempotency_key"],"state":reconciled["state"],"code":reconciled["code"],"details":reconciled["details"],"completedAt":utc_now()}
            self.outbox.enqueue_result(command_id,row["idempotency_key"],reconciled["state"],payload)
            print(f"[reconcile] broker history matched an uncertain order; state={reconciled['state']}",flush=True)
    def run(self):
        ok=self.ensure_session()
        reason="CONNECTED" if ok else self.last_error
        if ok: self.recover_uncertain_commands()
        print(f"[startup] agent={self.config.agent_id}; environment={self.config.environment}; session={'connected' if ok else reason}; live_trading_enabled={self.config.live_trading_enabled}; reconnect=enabled",flush=True)
        threading.Thread(target=self.market_data_loop,name="mt5-market-data",daemon=True).start()
        last_heartbeat=0.0
        while not self.stop.is_set():
            now=time.monotonic()
            if now-last_heartbeat>=self.config.heartbeat_seconds:
                self.heartbeat(); last_heartbeat=now
            self.flush_results()
            status,body=self.request("/api/bridge/v1/commands/next?agentId="+self.config.agent_id,timeout=12)
            if status==200 and isinstance(body.get("command"),dict): self.handle_command(body["command"])
            elif status not in (200,204,404): print(f"[commands] poll failed: HTTP {status} {body.get('error','HTTP_ERROR')}",flush=True)
            self.stop.wait(self.config.poll_seconds)
        self.session.close()

def main():
    try: Agent().run()
    except KeyboardInterrupt: pass
    except Exception as exc:
        print(f"FATAL: {type(exc).__name__}: {exc}",file=sys.stderr,flush=True)
        return 2
    return 0
if __name__=="__main__": raise SystemExit(main())
