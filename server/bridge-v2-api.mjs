import { timingSafeEqual } from "node:crypto";

function json(res,status,body) {
  const raw=JSON.stringify(body);
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","content-length":Buffer.byteLength(raw)});
  res.end(raw);
}
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function authorized(req,token) {
  const supplied=req.headers["x-bridge-token"];
  if(typeof token!=="string" || !token || typeof supplied!=="string") return false;
  const a=Buffer.from(token),b=Buffer.from(supplied);
  return a.length===b.length && timingSafeEqual(a,b);
}
async function readBody(req,limit=65536) {
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error("BODY_TOO_LARGE"),{status:413});chunks.push(chunk);}
  try {const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!isObject(value))throw new Error();return value;}
  catch {throw Object.assign(new Error("INVALID_JSON"),{status:400});}
}
class BridgeStore {
  constructor(env,fetchImpl=fetch) {
    this.url=(env.SUPABASE_URL||"").replace(/\/$/,"")+"/rest/v1";
    this.key=env.SUPABASE_SERVICE_ROLE_KEY||"";
    this.fetch=fetchImpl;
  }
  async request(path,init={}) {
    if(!this.key||!this.url.startsWith("https://")) throw new Error("BRIDGE_STORAGE_NOT_CONFIGURED");
    const response=await this.fetch(this.url+path,{...init,headers:{apikey:this.key,authorization:"Bearer "+this.key,"content-type":"application/json",Prefer:"return=representation",...(init.headers||{})},signal:AbortSignal.timeout(6000)});
    const raw=await response.text();let body=[];
    try{body=raw?JSON.parse(raw):[];}catch{throw new Error("BRIDGE_STORAGE_INVALID_RESPONSE");}
    if(!response.ok) throw new Error("BRIDGE_STORAGE_HTTP_"+response.status);
    return body;
  }
}
export async function readBridgeV2Status(env=process.env,agentId="windows-mt5-demo-01",fetchImpl=fetch) {
  const store=new BridgeStore(env,fetchImpl);
  const rows=await store.request("/bridge_agents?agent_id=eq."+encodeURIComponent(agentId)+"&select=agent_id,state,environment,terminal_connected,account_connected,execution_ready,broker_symbol,account_login,last_error_code,last_seen_at,payload&limit=1");
  const a=rows[0];
  if(!a) return {state:"DISCONNECTED",ready:false,reason:"AGENT_NOT_REGISTERED",lastSeenAt:null};
  const age=Date.now()-Date.parse(a.last_seen_at),alive=Number.isFinite(age)&&age<=30000;
  return {state:alive?a.state:"DISCONNECTED",ready:alive&&a.execution_ready===true,reason:alive?(a.last_error_code||"HEARTBEAT_OK"):"HEARTBEAT_STALE",lastSeenAt:a.last_seen_at,heartbeatAgeMs:Number.isFinite(age)?age:null,environment:a.environment,terminalConnected:alive&&a.terminal_connected,accountConnected:alive&&a.account_connected,executionReady:alive&&a.execution_ready,brokerSymbol:a.broker_symbol,accountLogin:a.account_login,quote:a.payload?.quote??null,symbolSpec:a.payload?.symbolSpec??null};
}
export async function readBridgeV2Candles(env,timeframe,count=120,fetchImpl=fetch) {
  if(!["M1","M5","M15","H1"].includes(timeframe)||!Number.isInteger(count)||count<35||count>500) return {ok:false,errorCode:"INVALID_CANDLE_REQUEST"};
  try {
    const store=new BridgeStore(env,fetchImpl);
    const agentId=env.MT5_AGENT_ID||"windows-mt5-demo-01";
    const rows=await store.request("/bridge_agents?agent_id=eq."+encodeURIComponent(agentId)+"&select=environment,payload&limit=1");
    const agent=rows[0];
    if(!agent||agent.environment!=="DEMO") return {ok:false,errorCode:"BRIDGE_V2_AGENT_NOT_AVAILABLE"};
    const snapshot=agent.payload?.marketCandles?.[timeframe];
    if(!snapshot||!Array.isArray(snapshot.candles)) return {ok:false,errorCode:"BRIDGE_V2_CANDLES_NOT_AVAILABLE"};
    const candles=snapshot.candles.slice(-count);
    if(candles.length<35) return {ok:false,errorCode:"BRIDGE_V2_INSUFFICIENT_CANDLES"};
    return {ok:true,value:{symbol:"XAUUSD",timeframe,candles,updatedAt:snapshot.updatedAt??null}};
  } catch(error) {
    const code=error instanceof Error?error.message:"BRIDGE_V2_CANDLES_UNAVAILABLE";
    return {ok:false,errorCode:code.startsWith("BRIDGE_STORAGE")?code:"BRIDGE_V2_CANDLES_UNAVAILABLE"};
  }
}


export async function readBridgeV2Positions(env,fetchImpl=fetch) {
  try {
    const store=new BridgeStore(env,fetchImpl);
    const agentId=env.MT5_AGENT_ID||"windows-mt5-demo-01";
    const rows=await store.request("/bridge_agents?agent_id=eq."+encodeURIComponent(agentId)+"&select=environment,last_seen_at,account_login,payload&limit=1");
    const agent=rows[0],age=agent?Date.now()-Date.parse(agent.last_seen_at):Infinity;
    if(!agent||agent.environment!=="DEMO"||!Number.isFinite(age)||age>30000) return {ok:false,errorCode:"BRIDGE_V2_AGENT_STALE"};
    const positions=agent.payload?.positions;
    if(!Array.isArray(positions)) return {ok:false,errorCode:"BRIDGE_V2_POSITIONS_NOT_AVAILABLE"};
    return {ok:true,value:{environment:"DEMO",accountLogin:agent.account_login,positions}};
  } catch(error) {
    const code=error instanceof Error?error.message:"BRIDGE_V2_POSITIONS_UNAVAILABLE";
    return {ok:false,errorCode:code.startsWith("BRIDGE_STORAGE")?code:"BRIDGE_V2_POSITIONS_UNAVAILABLE"};
  }
}
export async function readBridgeV2DailyRisk(env,fetchImpl=fetch) {
  try {
    const store=new BridgeStore(env,fetchImpl);
    const agentId=env.MT5_AGENT_ID||"windows-mt5-demo-01";
    const rows=await store.request("/bridge_agents?agent_id=eq."+encodeURIComponent(agentId)+"&select=environment,last_seen_at,account_login,payload&limit=1");
    const agent=rows[0],age=agent?Date.now()-Date.parse(agent.last_seen_at):Infinity;
    if(!agent||agent.environment!=="DEMO"||!Number.isFinite(age)||age>30000) return {ok:false,errorCode:"BRIDGE_V2_AGENT_STALE"};
    const risk=agent.payload?.dailyRisk;
    if(!risk||risk.source!=="MT5_CLOSED_DEALS_BOT_MAGIC"||risk.accountLogin!==String(agent.account_login)||!Number.isFinite(risk.balance)||risk.balance<=0||!Number.isFinite(risk.dailyNetPnl)||!Number.isInteger(risk.consecutiveLosses)||risk.consecutiveLosses<0) return {ok:false,errorCode:"BRIDGE_V2_DAILY_RISK_NOT_AVAILABLE"};
    return {ok:true,value:risk};
  } catch(error) {
    const code=error instanceof Error?error.message:"BRIDGE_V2_DAILY_RISK_UNAVAILABLE";
    return {ok:false,errorCode:code.startsWith("BRIDGE_STORAGE")?code:"BRIDGE_V2_DAILY_RISK_UNAVAILABLE"};
  }
}

export async function submitBridgeV2Order(env,intent,fetchImpl=fetch) {
  const store=new BridgeStore(env,fetchImpl);
  const agentId=env.MT5_AGENT_ID||"windows-mt5-demo-01";
  if(intent.environment!=="DEMO"||intent.symbol!=="XAUUSD"||!["BUY","SELL"].includes(intent.direction)||
     !Number.isFinite(intent.volume)||intent.volume<=0||!Number.isFinite(intent.stopLoss)||intent.stopLoss<=0||
     !Number.isFinite(intent.takeProfit)||intent.takeProfit<=0) return {ok:false,errorCode:"INVALID_ORDER",message:"Only validated XAUUSD Demo orders are accepted."};
  try {
    const agents=await store.request("/bridge_agents?agent_id=eq."+encodeURIComponent(agentId)+"&select=execution_ready,last_seen_at,environment&limit=1");
    const agent=agents[0],age=agent?Date.now()-Date.parse(agent.last_seen_at):Infinity;
    if(!agent||agent.environment!=="DEMO"||agent.execution_ready!==true||!Number.isFinite(age)||age>30000)
      return {ok:false,errorCode:"UNAVAILABLE",message:"MT5 Bridge V2 agent is not connected and Demo-ready."};
    const expiresAt=new Date(Date.now()+45000).toISOString();
    const payload={symbol:"XAUUSD",direction:intent.direction,volume:intent.volume,stopLoss:intent.stopLoss,takeProfit:intent.takeProfit};
    let rows=await store.request("/bridge_commands?on_conflict=idempotency_key",{method:"POST",headers:{Prefer:"resolution=ignore-duplicates,return=representation"},body:JSON.stringify({agent_id:agentId,idempotency_key:intent.idempotencyKey,kind:"EXECUTE_ORDER",environment:"DEMO",status:"PENDING",payload,created_at:new Date().toISOString(),expires_at:expiresAt})});
    let command=rows[0];
    if(!command) {
      const prior=await store.request("/bridge_commands?idempotency_key=eq."+encodeURIComponent(intent.idempotencyKey)+"&select=id,status,result&limit=1");
      if(prior[0]) return {ok:false,errorCode:"RECONCILIATION_REQUIRED",message:"This idempotency key already exists; automatic resubmission is forbidden."};
      return {ok:false,errorCode:"STORAGE_UNAVAILABLE",message:"Could not persist the Demo command."};
    }
    const deadline=Date.now()+30000;
    while(Date.now()<deadline) {
      const results=await store.request("/bridge_command_results?command_id=eq."+encodeURIComponent(command.id)+"&select=state,code,details&limit=1");
      if(results[0]) {
        const r=results[0];
        if(r.state==="FILLED") return {ok:true,value:{state:"CONFIRMED",brokerOrderId:r.details?.order??r.details?.deal??null,brokerDealId:r.details?.deal??null,details:r.details}};
        if(r.state==="REJECTED"||r.state==="EXPIRED") return {ok:false,errorCode:"BROKER_REJECTED",message:r.code||r.state,details:r.details};
        return {ok:false,errorCode:"RECONCILIATION_REQUIRED",message:r.code||"Execution result is unknown; reconcile before retrying."};
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    await store.request("/bridge_commands?id=eq."+encodeURIComponent(command.id)+"&status=in.(PENDING,CLAIMED)",{method:"PATCH",body:JSON.stringify({status:"UNKNOWN",result:{code:"RESULT_TIMEOUT"}})}).catch(()=>[]);
    return {ok:false,errorCode:"RECONCILIATION_REQUIRED",message:"No confirmed broker result arrived in time; do not resubmit this intent."};
  } catch(error) {
    const code=error instanceof Error?error.message:"BRIDGE_V2_UNAVAILABLE";
    return {ok:false,errorCode:"UNAVAILABLE",message:code.startsWith("BRIDGE_STORAGE")?code:"Bridge V2 service unavailable."};
  }
}
export function createBridgeV2Api(env=process.env,fetchImpl=fetch) {
  const store=new BridgeStore(env,fetchImpl);
  const token=env.MT5_BRIDGE_TOKEN||"";
  return async function handleBridgeV2(req,res,method,url) {
    if(!url.pathname.startsWith("/api/bridge/v1/")) return false;
    if(!["GET","POST"].includes(method)) {json(res,405,{error:"METHOD_NOT_ALLOWED"});return true;}
    if(!authorized(req,token)) {json(res,401,{error:"UNAUTHORIZED"});return true;}
    try {
      if(method==="POST"&&url.pathname==="/api/bridge/v1/heartbeat") {
        const body=await readBody(req);
        if(typeof body.agentId!=="string"||!/^[A-Za-z0-9._-]{1,80}$/.test(body.agentId)||body.environment!=="DEMO"||
          typeof body.terminalConnected!=="boolean"||typeof body.accountConnected!=="boolean"||typeof body.executionReady!=="boolean"||
          !["STARTING","CONNECTED","DEGRADED","DISCONNECTED"].includes(body.state)) {json(res,400,{error:"INVALID_HEARTBEAT"});return true;}
        const existing=await store.request("/bridge_agents?agent_id=eq."+encodeURIComponent(body.agentId)+"&select=payload&limit=1");
        const oldPayload=isObject(existing[0]?.payload)?existing[0].payload:{};
        const marketCandles=isObject(oldPayload.marketCandles)?oldPayload.marketCandles:null;
        const nextPayload={...body,...(marketCandles?{marketCandles}:{})};
        const rows=await store.request("/bridge_agents?on_conflict=agent_id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=representation"},body:JSON.stringify({
          agent_id:body.agentId,state:body.state,environment:"DEMO",terminal_connected:body.terminalConnected,account_connected:body.accountConnected,
          execution_ready:body.executionReady,broker_symbol:typeof body.brokerSymbol==="string"?body.brokerSymbol:null,
          account_login:typeof body.accountLogin==="string"?body.accountLogin:null,last_error_code:typeof body.lastErrorCode==="string"?body.lastErrorCode:null,
          last_seen_at:new Date().toISOString(),payload:nextPayload
        })});
        json(res,200,{ok:true,agentId:body.agentId,acceptedAt:new Date().toISOString(),executionReady:Boolean(rows[0]?.execution_ready)});return true;
      }
      if(method==="POST"&&url.pathname==="/api/bridge/v1/market/candles") {
        const body=await readBody(req,100000);
        const allowedTimeframes=["M1","M5","M15","H1"];
        if(typeof body.agentId!=="string"||!/^[A-Za-z0-9._-]{1,80}$/.test(body.agentId)||
          !allowedTimeframes.includes(body.timeframe)||!Array.isArray(body.candles)||body.candles.length<35||body.candles.length>500) {
          json(res,400,{error:"INVALID_CANDLE_SNAPSHOT"});return true;
        }
        const clean=[];let previousOpen=-Infinity;const now=Date.now();
        const durations={M1:60000,M5:300000,M15:900000,H1:3600000};
        for(const bar of body.candles) {
          if(!isObject(bar)||bar.symbol!=="XAUUSD"||bar.timeframe!==body.timeframe||bar.isClosed!==true||
            typeof bar.openTime!=="string"||typeof bar.closeTime!=="string"||
            ![bar.open,bar.high,bar.low,bar.close].every(x=>typeof x==="number"&&Number.isFinite(x)&&x>0)||
            !(typeof bar.tickVolume==="number"&&Number.isFinite(bar.tickVolume)&&bar.tickVolume>=0)) {
            json(res,400,{error:"INVALID_CANDLE_FIELDS"});return true;
          }
          const opened=Date.parse(bar.openTime),closed=Date.parse(bar.closeTime);
          if(!Number.isFinite(opened)||!Number.isFinite(closed)||opened<=previousOpen||closed<=opened||
            closed-opened!==durations[body.timeframe]||closed>now+5000||
            bar.high<Math.max(bar.open,bar.close,bar.low)||bar.low>Math.min(bar.open,bar.close,bar.high)) {
            json(res,400,{error:"INVALID_CANDLE_GEOMETRY_OR_TIME"});return true;
          }
          previousOpen=opened;
          clean.push({symbol:"XAUUSD",timeframe:body.timeframe,openTime:new Date(opened).toISOString(),closeTime:new Date(closed).toISOString(),open:bar.open,high:bar.high,low:bar.low,close:bar.close,tickVolume:Math.trunc(bar.tickVolume),isClosed:true});
        }
        const store=new BridgeStore(env,fetchImpl);
        const agents=await store.request("/bridge_agents?agent_id=eq."+encodeURIComponent(body.agentId)+"&select=agent_id,environment,last_seen_at,payload&limit=1");
        const agent=agents[0],age=agent?Date.now()-Date.parse(agent.last_seen_at):Infinity;
        if(!agent||agent.environment!=="DEMO"||!Number.isFinite(age)||age>30000) {json(res,409,{error:"BRIDGE_V2_AGENT_NOT_FRESH"});return true;}
        const prior=isObject(agent.payload)?agent.payload:{};
        const priorCandles=isObject(prior.marketCandles)?prior.marketCandles:{};
        const nextPayload={...prior,marketCandles:{...priorCandles,[body.timeframe]:{candles:clean,updatedAt:new Date().toISOString()}}};
        await store.request("/bridge_agents?agent_id=eq."+encodeURIComponent(body.agentId),{method:"PATCH",body:JSON.stringify({payload:nextPayload})});
        json(res,200,{ok:true,timeframe:body.timeframe,acceptedBars:clean.length,latestClosedBarTime:clean[clean.length-1].closeTime});return true;
      }
      if(method==="GET"&&url.pathname==="/api/bridge/v1/status") {
        const agentId=url.searchParams.get("agentId")||"windows-mt5-demo-01";
        const rows=await store.request("/bridge_agents?agent_id=eq."+encodeURIComponent(agentId)+"&select=agent_id,state,environment,terminal_connected,account_connected,execution_ready,broker_symbol,last_error_code,last_seen_at&limit=1");
        const a=rows[0];
        if(!a){json(res,200,{state:"DISCONNECTED",ready:false,reason:"AGENT_NOT_REGISTERED",lastSeenAt:null});return true;}
        const age=Date.now()-Date.parse(a.last_seen_at);
        const alive=Number.isFinite(age)&&age<=30000;
        json(res,200,{state:alive?a.state:"DISCONNECTED",ready:alive&&a.execution_ready===true,reason:alive?(a.last_error_code||"HEARTBEAT_OK"):"HEARTBEAT_STALE",lastSeenAt:a.last_seen_at,heartbeatAgeMs:Number.isFinite(age)?age:null,environment:a.environment,terminalConnected:alive&&a.terminal_connected,accountConnected:alive&&a.account_connected,executionReady:alive&&a.execution_ready,brokerSymbol:a.broker_symbol});return true;
      }
      if(method==="GET"&&url.pathname==="/api/bridge/v1/commands/next") {
        const agentId=url.searchParams.get("agentId");
        if(!agentId||!/^[A-Za-z0-9._-]{1,80}$/.test(agentId)){json(res,400,{error:"INVALID_AGENT_ID"});return true;}
        const nowIso=new Date().toISOString();
        await store.request("/bridge_commands?agent_id=eq."+encodeURIComponent(agentId)+"&status=eq.PENDING&expires_at=lt."+encodeURIComponent(nowIso),{method:"PATCH",body:JSON.stringify({status:"EXPIRED",completed_at:nowIso,result:{code:"COMMAND_EXPIRED_BEFORE_CLAIM"}})}).catch(()=>[]);
        const staleClaimCutoff=new Date(Date.now()-60000).toISOString();
        await store.request("/bridge_commands?agent_id=eq."+encodeURIComponent(agentId)+"&status=eq.CLAIMED&claimed_at=lt."+encodeURIComponent(staleClaimCutoff),{method:"PATCH",body:JSON.stringify({status:"UNKNOWN",result:{code:"CLAIM_LEASE_EXPIRED_REQUIRES_RECONCILIATION"}})}).catch(()=>[]);
        const rows=await store.request("/bridge_commands?agent_id=eq."+encodeURIComponent(agentId)+"&status=eq.PENDING&expires_at=gt."+encodeURIComponent(new Date().toISOString())+"&select=id,idempotency_key,kind,environment,payload,expires_at&order=created_at.asc&limit=1");
        const c=rows[0];if(!c){json(res,200,{command:null});return true;}
        const claimed=await store.request("/bridge_commands?id=eq."+encodeURIComponent(c.id)+"&status=eq.PENDING",{method:"PATCH",body:JSON.stringify({status:"CLAIMED",claimed_at:new Date().toISOString()})});
        if(!claimed.length){json(res,200,{command:null});return true;}
        json(res,200,{command:{id:c.id,idempotencyKey:c.idempotency_key,kind:c.kind,environment:c.environment,payload:c.payload,expiresAt:c.expires_at}});return true;
      }
      const resultMatch=url.pathname.match(/^\/api\/bridge\/v1\/commands\/([0-9a-f-]{36})\/result$/i);
      if(method==="POST"&&resultMatch) {
        const commandId=resultMatch[1],body=await readBody(req);
        if(body.commandId!==commandId||typeof body.idempotencyKey!=="string"||!["FILLED","REJECTED","UNKNOWN","EXPIRED"].includes(body.state)||typeof body.code!=="string"||!isObject(body.details)){json(res,400,{error:"INVALID_COMMAND_RESULT"});return true;}
        const existing=await store.request("/bridge_command_results?command_id=eq."+encodeURIComponent(commandId)+"&select=command_id,idempotency_key,state&limit=1");
        if(existing.length){
          if(existing[0].idempotency_key!==body.idempotencyKey){json(res,409,{error:"IDEMPOTENCY_CONFLICT"});return true;}
          if(existing[0].state==="UNKNOWN"&&["FILLED","REJECTED"].includes(body.state)){
            await store.request("/bridge_command_results?command_id=eq."+encodeURIComponent(commandId)+"&state=eq.UNKNOWN",{method:"PATCH",body:JSON.stringify({state:body.state,code:body.code,details:body.details,completed_at:body.completedAt||new Date().toISOString()})});
            await store.request("/bridge_commands?id=eq."+encodeURIComponent(commandId),{method:"PATCH",body:JSON.stringify({status:body.state,completed_at:new Date().toISOString(),result:body})});
            json(res,200,{ok:true,reconciled:true});return true;
          }
          json(res,200,{ok:true,duplicate:true});return true;
        }
        const commands=await store.request("/bridge_commands?id=eq."+encodeURIComponent(commandId)+"&select=id,idempotency_key,status&limit=1");
        const c=commands[0];if(!c){json(res,404,{error:"UNKNOWN_COMMAND"});return true;}
        if(c.idempotency_key!==body.idempotencyKey){json(res,409,{error:"IDEMPOTENCY_CONFLICT"});return true;}
        await store.request("/bridge_command_results",{method:"POST",body:JSON.stringify({command_id:commandId,idempotency_key:body.idempotencyKey,state:body.state,code:body.code,details:body.details,completed_at:body.completedAt||new Date().toISOString()})});
        await store.request("/bridge_commands?id=eq."+encodeURIComponent(commandId),{method:"PATCH",body:JSON.stringify({status:body.state,completed_at:new Date().toISOString(),result:body})});
        json(res,200,{ok:true});return true;
      }
      json(res,404,{error:"BRIDGE_V2_ROUTE_NOT_FOUND"});return true;
    } catch(error) {
      const message=error instanceof Error?error.message:"BRIDGE_V2_INTERNAL_ERROR";
      const status=message==="BODY_TOO_LARGE"?413:message==="INVALID_JSON"?400:message==="BRIDGE_STORAGE_NOT_CONFIGURED"?503:503;
      json(res,status,{error:status===503?"BRIDGE_V2_UNAVAILABLE":message});return true;
    }
  };
}
