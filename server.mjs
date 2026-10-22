import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRiskSettings, TelegramBotClient, TelegramClientError, SupabaseRestRepository,
  MT5BridgeClient, normalizeClosedCandles, analyzeClosedMarket,
  OpenAICompatibleAIProvider, coordinateTechnicalAndAI, prepareExecutionIntent, atr, managePositionStop
} from "./dist/index.js";
import { runHistoricalBacktest } from "./server/backtest-engine.mjs";

const root = fileURLToPath(new URL("./web/", import.meta.url)).replace(/[\\/]+$/, "");
const MIME = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".svg":"image/svg+xml" };
function sendJson(res,status,body) {
  const data = JSON.stringify(body);
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","content-length":Buffer.byteLength(data)});
  res.end(data);
}
async function readJson(req,maxBytes=16384) {
  const chunks=[]; let total=0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error("Request body is too large"),{status:413});
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { const value=JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error("Invalid JSON body"),{status:400}); }
}
function configuredSupabase(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try { return new SupabaseRestRepository({projectUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY}); }
  catch { return null; }
}
function configuredBridge(env) {
  if (!env.MT5_BRIDGE_URL || !env.MT5_BRIDGE_TOKEN) return null;
  try { return new MT5BridgeClient({baseUrl:env.MT5_BRIDGE_URL,token:env.MT5_BRIDGE_TOKEN}); }
  catch { return null; }
}
function allowedAIBaseUrl(value) {
  try {
    const endpoint=new URL(value);
    const allowedProtocol=endpoint.protocol==="https:" || endpoint.hostname==="localhost" || endpoint.hostname==="127.0.0.1";
    return allowedProtocol && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash;
  } catch { return false; }
}
function aiProviderCatalogFromEnv(env) {
  const catalog=[];
  if (env.AI_PROVIDER_CATALOG_JSON) {
    try {
      const raw=JSON.parse(env.AI_PROVIDER_CATALOG_JSON);
      if (Array.isArray(raw)) for (const item of raw) {
        if (!item || typeof item!=="object" || typeof item.id!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.id) ||
            typeof item.label!=="string" || !item.label.trim() || typeof item.baseUrl!=="string" || !allowedAIBaseUrl(item.baseUrl) ||
            typeof item.apiKeyEnv!=="string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(item.apiKeyEnv) || !Array.isArray(item.models)) continue;
        const models=[];
        for (const model of item.models) {
          const modelId=typeof model==="string"?model:model && typeof model.id==="string"?model.id:null;
          const label=typeof model==="object" && model && typeof model.label==="string"?model.label:modelId;
          if (modelId && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(modelId) && !models.some(existing=>existing.id===modelId)) models.push({id:modelId,label});
        }
        if (models.length && !catalog.some(existing=>existing.id===item.id)) catalog.push({id:item.id,label:item.label,baseUrl:item.baseUrl,apiKeyEnv:item.apiKeyEnv,models});
      }
    } catch {}
  }
  if (!catalog.length && env.AI_BASE_URL && env.AI_MODEL_ID && allowedAIBaseUrl(env.AI_BASE_URL)) {
    const ids=[...(env.AI_ALLOWED_MODELS??"").split(","),env.AI_MODEL_ID].map(value=>value.trim()).filter(value=>/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value));
    const models=[...new Set(ids)].map(id=>({id,label:id}));
    catalog.push({id:env.AI_PROVIDER_ID||"openai-compatible",label:env.AI_PROVIDER_LABEL||env.AI_PROVIDER_ID||"OpenAI-compatible",baseUrl:env.AI_BASE_URL,apiKeyEnv:"AI_API_KEY",models});
  }
  return catalog;
}
function configuredAI(env, catalog, providerId, modelId) {
  const provider=catalog.find(item=>item.id===providerId);
  if (!provider || !provider.models.some(model=>model.id===modelId)) return null;
  const apiKey=env[provider.apiKeyEnv];
  if (typeof apiKey!=="string" || !apiKey.trim()) return null;
  try {
    return new OpenAICompatibleAIProvider({
      providerId:provider.id,modelId,
      baseUrl:provider.baseUrl,apiKey,timeoutMs:15000,assessmentTtlMs:60000
    });
  } catch { return null; }
}
export function scanFreshnessPolicy(triggerType) {
  const manual=triggerType==="MANUAL";
  return {maxAgeSeconds:manual?70:35,maxM1AgeMs:manual?70000:20000};
}
let economicCalendarCache = { expiresAt: 0, events: null, apiKey: null, from: null, to: null };
export async function economicCalendarBlock(env, nowMs=Date.now(), fetchImpl=fetch) {
  const apiKey=typeof env.FINNHUB_API_KEY==="string"?env.FINNHUB_API_KEY.trim():"";
  if (!apiKey) return "NEWS_CALENDAR_NOT_CONFIGURED";
  const from=new Date(nowMs-24*60*60*1000).toISOString().slice(0,10);
  const to=new Date(nowMs+24*60*60*1000).toISOString().slice(0,10);
  const sameCacheKey=economicCalendarCache.apiKey===apiKey && economicCalendarCache.from===from && economicCalendarCache.to===to;
  const staleCachedEvents=sameCacheKey ? economicCalendarCache.events : null;
  let events=economicCalendarCache.expiresAt>Date.now() && sameCacheKey ? economicCalendarCache.events : null;
  if (!events) {
    const endpoint=new URL("https://finnhub.io/api/v1/calendar/economic");
    endpoint.searchParams.set("from",from);
    endpoint.searchParams.set("to",to);
    endpoint.searchParams.set("token",apiKey);
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),4000);
    try {
      const response=await fetchImpl(endpoint,{signal:controller.signal,headers:{accept:"application/json"}});
      if (!response.ok) { events=staleCachedEvents; if (!events) return "NEWS_CALENDAR_UNAVAILABLE"; }
      if (response.ok) {
        const body=await response.json();
        if (!body || !Array.isArray(body.economicCalendar)) { events=staleCachedEvents; if (!events) return "NEWS_CALENDAR_UNAVAILABLE"; }
        else { events=body.economicCalendar; economicCalendarCache={expiresAt:Date.now()+60_000,events,apiKey,from,to}; }
      }
    } catch { events=staleCachedEvents; if (!events) return "NEWS_CALENDAR_UNAVAILABLE"; }
    finally { clearTimeout(timeout); }
  }
  const highImpact=events.filter(event=>event && (event.country==="US" || event.country==="USD") &&
    (event.impact===3 || String(event.impact).toLowerCase()==="high") && typeof event.time==="string");
  for (const event of highImpact) {
    const rawTime=event.time.trim();
    // Finnhub may return a UTC datetime without an explicit timezone suffix.
    const normalizedTime=/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawTime)
      ? rawTime
      : rawTime.replace(" ","T")+"Z";
    const eventMs=Date.parse(normalizedTime);
    // Wider post-release protection: 15 minutes before, 45 minutes after.
    if (Number.isFinite(eventMs) && eventMs>=nowMs-45*60*1000 && eventMs<=nowMs+15*60*1000) return "HIGH_IMPACT_NEWS_BLACKOUT";
  }
  return null;
}
export function tradingTimeBlock(env, nowMs=Date.now()) {
  // JustMarkets metals server time is GMT+3; the published daily break is 23:58–01:01.
  // Block new entries slightly around the break; timestamps remain UTC internally.
  const brokerDate=new Date(nowMs+3*60*60*1000);
  const minute=brokerDate.getUTCHours()*60+brokerDate.getUTCMinutes();
  if (minute>=23*60+55 || minute<65) return "ROLLOVER_BLACKOUT";
  const configured=(env.HIGH_IMPACT_NEWS_BLACKOUTS_UTC||"").split(",").map(item=>item.trim()).filter(Boolean);
  for (const range of configured) {
    const parts=range.split("/");
    if (parts.length!==2) continue;
    const start=Date.parse(parts[0]),end=Date.parse(parts[1]);
    if (Number.isFinite(start)&&Number.isFinite(end)&&end>start&&nowMs>=start&&nowMs<=end) return "HIGH_IMPACT_NEWS_BLACKOUT";
  }
  return null;
}
function validRiskSettings(value) {
  return value && typeof value === "object" && validateRiskSettings(value) === null;
}
function dailyLossGuardConfig(env={}, settings=null) {
  const maxDailyLossPercent=settings?.maxDailyLossPercent ?? Number(env.MAX_DAILY_LOSS_PERCENT);
  const maxConsecutiveLosses=settings?.maxConsecutiveLosses ?? Number(env.MAX_CONSECUTIVE_LOSSES);
  if (!Number.isFinite(maxDailyLossPercent) || maxDailyLossPercent<=0 || maxDailyLossPercent>100 ||
      !Number.isInteger(maxConsecutiveLosses) || maxConsecutiveLosses<1 || maxConsecutiveLosses>100) return null;
  return {maxDailyLossPercent,maxConsecutiveLosses};
}
export function evaluateDailyRiskGuard(env, risk, expectedAccountLogin, settings=null) {
  const limits=dailyLossGuardConfig(env,settings);
  if (!limits) return {ok:false,code:"DAILY_RISK_LIMITS_NOT_CONFIGURED"};
  if (!risk || risk.accountLogin!==String(expectedAccountLogin) ||
      risk.source!=="MT5_CLOSED_DEALS_BOT_MAGIC" ||
      !Number.isFinite(risk.balance) || risk.balance<=0 ||
      !Number.isFinite(risk.dailyNetPnl) || !Number.isInteger(risk.consecutiveLosses) ||
      risk.consecutiveLosses<0) return {ok:false,code:"DAILY_RISK_HISTORY_UNAVAILABLE"};
  const dailyLossPercent=Math.max(0,-risk.dailyNetPnl)/risk.balance*100;
  if (dailyLossPercent>=limits.maxDailyLossPercent) return {ok:false,code:"DAILY_LOSS_LIMIT_REACHED",dailyLossPercent,dailyNetPnl:risk.dailyNetPnl,consecutiveLosses:risk.consecutiveLosses,dayStartUtc:risk.dayStartUtc};
  if (risk.consecutiveLosses>=limits.maxConsecutiveLosses) return {ok:false,code:"CONSECUTIVE_LOSS_LIMIT_REACHED",dailyLossPercent,dailyNetPnl:risk.dailyNetPnl,consecutiveLosses:risk.consecutiveLosses,dayStartUtc:risk.dayStartUtc};
  return {ok:true,dailyLossPercent,dailyNetPnl:risk.dailyNetPnl,consecutiveLosses:risk.consecutiveLosses};
}
export function createAppServer(env = process.env) {
  const telegram = new TelegramBotClient(env.TELEGRAM_BOT_TOKEN);
  const supabase = configuredSupabase(env);
  const bridge = configuredBridge(env);
  const relayJobs = [];
  const relayWaiters = new Map();
  const relayResults = new Map();
  const relayToken = typeof env.MT5_BRIDGE_TOKEN === "string" ? env.MT5_BRIDGE_TOKEN : "";
  const aiCatalog = aiProviderCatalogFromEnv(env);
  const config = { aiProviderId:null, aiModelId:null };
  let aiProvider = null;
  let aiConfigured = false;
  const modelIdPattern=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
  function buildConfiguredAI(providerId, modelId) {
    if (typeof providerId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(providerId) ||
        typeof modelId!=="string" || !modelIdPattern.test(modelId)) return null;
    const allowedProviderId=env.AI_PROVIDER_ID || "openai-compatible";
    if (providerId!==allowedProviderId) return null;
    const baseUrl=env.AI_BASE_URL;
    const apiKey=env.AI_API_KEY;
    if (typeof baseUrl!=="string" || !allowedAIBaseUrl(baseUrl) || typeof apiKey!=="string" || !apiKey.trim()) return null;
    const allowedModels=(env.AI_ALLOWED_MODELS||"").split(",").map(value=>value.trim()).filter(Boolean);
    if (allowedModels.length && !allowedModels.includes(modelId)) return null;
    try { return new OpenAICompatibleAIProvider({providerId,modelId,baseUrl,apiKey,timeoutMs:15000,assessmentTtlMs:60000}); }
    catch { return null; }
  }
  const enabledChats = new Set();
  const localNotificationKeys = new Set();
  let riskSettings = null;
  let scannerRuns = [];
  let scannerEnabled = false;
  let autoTradingEnabled = false;
  const liveTradingEnabled = env.LIVE_TRADING_ENABLED === "true" && env.LIVE_TRADING_CONFIRMATION === "I_UNDERSTAND_LIVE_TRADING_RISK";
  let executionEnvironment = "DEMO";
  let aiProbePassed = false;
  let scannerTimer = null;
  let nextScheduledScanAt = null;
  let scanInFlight = false;
  let backtestInFlight = false;
  let settingsHydrated = false;
  let outboxInFlight = false;
  async function sendWithOutbox(chatId, message, messageType, dedupeKey) {
    if (!telegram.configured) return {ok:false,errorCode:"NOT_CONFIGURED",persisted:Boolean(supabase)};
    const now = new Date().toISOString();
    let notificationId = randomUUID();
    if (supabase) {
      const queued = await supabase.insertRecord("notification_outbox", {
        id:notificationId,dedupe_key:dedupeKey,chat_id:chatId,message_type:messageType,
        payload:{text:message},status:"PENDING",attempts:0,created_at:now
      });
      if (!queued.ok) return {ok:false,errorCode:queued.errorCode,persisted:false};
      const claimed = await supabase.updateRecord("notification_outbox",notificationId,{status:"SENDING",attempts:1});
      if (!claimed.ok || !claimed.value.updated) return {ok:false,errorCode:"OUTBOX_CLAIM_FAILED",persisted:false};
    }
    try {
      const sent = await telegram.sendMessage(chatId,message);
      if (supabase) {
        const saved = await supabase.updateRecord("notification_outbox",notificationId,{
          status:"SENT",attempts:1,delivered_at:new Date().toISOString(),next_attempt_at:null,last_error_code:null
        });
        return {ok:true,messageId:sent.messageId,persisted:saved.ok && saved.value.updated};
      }
      return {ok:true,messageId:sent.messageId,persisted:false};
    } catch (error) {
      if (supabase) {
        const retrySeconds = error instanceof TelegramClientError ? error.retryAfterSeconds ?? 60 : 60;
        await supabase.updateRecord("notification_outbox",notificationId,{
          status:"FAILED",attempts:1,next_attempt_at:new Date(Date.now()+Math.max(15,retrySeconds)*1000).toISOString(),
          last_error_code:error instanceof TelegramClientError?error.code:"HTTP_ERROR"
        });
      }
      return {ok:false,errorCode:error instanceof TelegramClientError?error.code:"HTTP_ERROR",persisted:Boolean(supabase)};
    }
  }
  async function drainOutbox() {
    if (!supabase || !telegram.configured || outboxInFlight) return;
    outboxInFlight = true;
    try {
      const pending = await supabase.listPendingNotifications(10);
      for (const item of pending) {
        if (typeof item.id!=="string" || typeof item.chat_id!=="string" || !item.payload || typeof item.payload!=="object" || typeof item.payload.text!=="string") continue;
        const attempts = typeof item.attempts==="number" ? item.attempts+1 : 1;
        const claim = await supabase.updateRecord("notification_outbox",item.id,{status:"SENDING",attempts});
        if (!claim.ok || !claim.value.updated) continue;
        try {
          await telegram.sendMessage(item.chat_id,item.payload.text);
          await supabase.updateRecord("notification_outbox",item.id,{status:"SENT",attempts,delivered_at:new Date().toISOString(),next_attempt_at:null,last_error_code:null});
        } catch (error) {
          const retrySeconds = error instanceof TelegramClientError ? error.retryAfterSeconds ?? 60 : 60;
          await supabase.updateRecord("notification_outbox",item.id,{
            status:"FAILED",attempts,next_attempt_at:new Date(Date.now()+Math.max(15,retrySeconds)*1000).toISOString(),
            last_error_code:error instanceof TelegramClientError?error.code:"HTTP_ERROR"
          });
          if (error instanceof TelegramClientError && error.code==="RATE_LIMITED") break;
        }
      }
    } catch {}
    finally { outboxInFlight = false; }
  }
  async function queueNotificationToEnabled(message, messageType, dedupeKey) {
    if (!telegram.configured) return {sent:0,failed:0,reason:"TELEGRAM_NOT_CONFIGURED"};
    if (supabase) {
      let chats;
      try { chats=await supabase.listEnabledTelegramChats(); }
      catch { return {sent:0,failed:0,reason:"OUTBOX_UNAVAILABLE"}; }
      let queued=0, failed=0;
      for (const chat of chats) {
        if (typeof chat.chat_id!=="string") continue;
        const result=await supabase.insertRecord("notification_outbox",{
          id:randomUUID(),dedupe_key:dedupeKey+":"+chat.chat_id,chat_id:chat.chat_id,message_type:messageType,
          payload:{text:message},status:"PENDING",attempts:0,created_at:new Date().toISOString()
        });
        if (result.ok) queued++; else if (result.errorCode!=="ALREADY_EXISTS") failed++;
      }
      void drainOutbox().catch(()=>undefined);
      return {sent:queued,failed,reason:failed?"OUTBOX_PARTIAL_FAILURE":"QUEUED"};
    }
    const recipients=[...enabledChats].filter(chatId=>!localNotificationKeys.has(dedupeKey+":"+chatId));
    if (!recipients.length) return {sent:0,failed:0,reason:"DUPLICATE_SUPPRESSED"};
    void telegram.sendToDiscoveredChats(message,recipients).then(results=>{
      for (const result of results) if (result.ok) localNotificationKeys.add(dedupeKey+":"+result.chatId);
      while (localNotificationKeys.size>500) localNotificationKeys.delete(localNotificationKeys.values().next().value);
    }).catch(()=>undefined);
    return {sent:0,failed:0,reason:"PROCESS_LOCAL_QUEUED"};
  }


  async function hydrateSettings() {
    if (settingsHydrated) return;
    if (!supabase) { settingsHydrated=true; return; }
    try {
      const current = await supabase.readCurrent();
      if (validRiskSettings(current.riskSettings)) riskSettings = Object.freeze({...current.riskSettings});
      const storedProvider=typeof current.aiProviderId==="string"?current.aiProviderId:null;
      const storedModel=typeof current.aiModelId==="string"?current.aiModelId:null;
      const restored=storedProvider && storedModel ? buildConfiguredAI(storedProvider,storedModel) : null;
      if (restored) {
        config.aiProviderId=storedProvider;
        config.aiModelId=storedModel;
        aiProvider=restored;
        aiConfigured=true;
        aiProbePassed=false;
      }
      settingsHydrated=true;
    } catch {}
  }


  async function manageOpenPositions(normalized, health) {
    if (!autoTradingEnabled) return {ok:true,changed:0};
    if (!supabase || !bridge || !health.accountLogin) return {ok:false,reason:"POSITION_MANAGER_PREREQUISITES_MISSING"};
    try {
      const [livePositions,quote,spec] = await Promise.all([bridge.positions(),bridge.quote(),bridge.symbolSpec()]);
      if (!livePositions.ok || !quote.ok || !spec.ok || livePositions.value.environment!==executionEnvironment || livePositions.value.accountLogin!==health.accountLogin) {
        return {ok:false,reason:"POSITION_RECONCILIATION_UNAVAILABLE"};
      }
      if (livePositions.value.positions.some(position=>!position.ownedByBot)) return {ok:false,reason:"UNOWNED_XAUUSD_POSITION_CONFLICT"};
      const botPositions=livePositions.value.positions.filter(position=>position.ownedByBot);
      const m1=normalized.M1;
      const atrValues=atr(m1.map(bar=>bar.high),m1.map(bar=>bar.low),m1.map(bar=>bar.close),14);
      const atrValue=atrValues[atrValues.length-1];
      if (atrValue===undefined || !Number.isFinite(atrValue) || atrValue<=0) return {ok:false,reason:"POSITION_ATR_UNAVAILABLE"};
      const accountLogin=String(health.accountLogin);
      const liveTickets=new Set(botPositions.map(position=>String(position.ticket)));
      const databasePositions=await supabase.listOpenPositions(accountLogin);
      for (const stored of databasePositions) {
        if (typeof stored.id!=="string" || typeof stored.broker_position_id!=="string") continue;
        if (!liveTickets.has(stored.broker_position_id)) {
          const closed=await supabase.updateRecord("positions",stored.id,{status:"CLOSED",closed_at:new Date().toISOString(),updated_at:new Date().toISOString()});
          if (!closed.ok || !closed.value.updated) return {ok:false,reason:"CLOSED_POSITION_PERSIST_FAILED"};
          await supabase.insertRecord("trade_events",{id:randomUUID(),position_id:stored.id,execution_intent_id:null,event_type:"POSITION_CLOSED_RECONCILED",payload:{brokerPositionId:stored.broker_position_id},occurred_at:new Date().toISOString()});
        }
      }
      let changed=0;
      for (const position of botPositions) {
        const existing=databasePositions.find(item=>item.broker_position_id===String(position.ticket));
        const storedInitial=Number(existing?.initial_stop_loss ?? existing?.stop_loss);
        const initialStopLoss=Number.isFinite(storedInitial) && storedInitial>0 ? storedInitial : position.stopLoss;
        const saved=await supabase.upsertPosition({
          accountLogin,ticket:position.ticket,direction:position.direction,volume:position.volume,
          entryPrice:position.entryPrice,stopLoss:position.stopLoss,takeProfit:position.takeProfit,initialStopLoss,openedAt:position.openedAt
        });
        if (!saved.ok) return {ok:false,reason:"OPEN_POSITION_PERSIST_FAILED"};
        const currentPrice=position.direction==="BUY"?quote.value.bid:quote.value.ask;
        const management=managePositionStop({...position,initialStopLoss},currentPrice,atrValue,{
          breakEvenAtR:1.2,trailingStartsAtR:1.5,trailingAtrMultiplier:1.2,
          priceDigits:spec.value.priceDigits,tickSize:spec.value.tickSize,
          minimumStopDistance:spec.value.point*spec.value.stopsLevelPoints
        });
        if (management.action!=="MODIFY_STOP") continue;
        const modified=await bridge.modifyPosition({ticket:position.ticket,stopLoss:management.stopLoss,takeProfit:position.takeProfit});
        if (!modified.ok || modified.value.state!=="CONFIRMED") return {ok:false,reason:"POSITION_MODIFICATION_UNCONFIRMED"};
        const savedUpdate=await supabase.upsertPosition({
          accountLogin,ticket:position.ticket,direction:position.direction,volume:position.volume,
          entryPrice:position.entryPrice,stopLoss:management.stopLoss,takeProfit:position.takeProfit,initialStopLoss,openedAt:position.openedAt
        });
        if (!savedUpdate.ok) return {ok:false,reason:"POSITION_UPDATE_PERSIST_FAILED"};
        const event=await supabase.insertRecord("trade_events",{
          id:randomUUID(),position_id:savedUpdate.value.id,execution_intent_id:null,event_type:"STOP_LOSS_TIGHTENED",
          payload:{ticket:position.ticket,reason:management.reason,previousStopLoss:position.stopLoss,newStopLoss:management.stopLoss,takeProfitUnchanged:true},
          occurred_at:new Date().toISOString()
        });
        if (!event.ok) return {ok:false,reason:"POSITION_AUDIT_PERSIST_FAILED"};
        await queueNotificationToEnabled("تم تحسين وقف الخسارة لصفقة XAUUSD رقم "+position.ticket+" إلى "+management.stopLoss+". لم يتغير هدف الربح.","POSITION_STOP_TIGHTENED","position-stop:"+position.ticket+":"+management.stopLoss);
        changed++;
      }
      return {ok:true,changed,openPositionCount:botPositions.length};
    } catch {
      return {ok:false,reason:"POSITION_MANAGER_FAILURE"};
    }
  }

  async function reconcilePendingExecutionIntents(health) {
    if (!supabase) return {ok:true};
    let pending;
    try { pending=await supabase.listUnresolvedExecutionIntents(25); }
    catch { return {ok:false,reason:"UNRESOLVED_INTENTS_UNAVAILABLE"}; }
    for (const intent of pending) {
      if (typeof intent.id!=="string" || typeof intent.idempotency_key!=="string" || typeof intent.status!=="string") {
        return {ok:false,reason:"INVALID_STORED_EXECUTION_INTENT"};
      }
      const lookup=await bridge.lookupOrder(intent.idempotency_key);
      if (lookup.ok) {
        if (lookup.value.state==="CONFIRMED") {
          const updated=await supabase.updateExecutionIntentStatus(intent.id,"CONFIRMED");
          if (!updated.ok || !updated.value.updated) return {ok:false,reason:"CONFIRMED_INTENT_RECOVERY_FAILED"};
          const brokerOrderId=lookup.value.brokerOrderId;
          if (health.accountLogin && typeof brokerOrderId==="string" && brokerOrderId) {
            const order=await supabase.insertRecord("broker_orders",{
              id:randomUUID(),execution_intent_id:intent.id,account_login:String(health.accountLogin),
              broker_order_id:brokerOrderId,status:"CONFIRMED",request_payload:{recovered:true},
              response_payload:lookup.value,created_at:new Date().toISOString(),updated_at:new Date().toISOString()
            });
            if (!order.ok && order.errorCode!=="ALREADY_EXISTS") return {ok:false,reason:"RECOVERED_ORDER_PERSIST_FAILED"};
          }
          const event=await supabase.insertRecord("trade_events",{id:randomUUID(),execution_intent_id:intent.id,event_type:"EXECUTION_CONFIRMED_ON_RECOVERY",payload:{brokerOrderId},occurred_at:new Date().toISOString()});
          if (!event.ok) return {ok:false,reason:"RECOVERY_AUDIT_FAILED"};
          continue;
        }
        if (lookup.value.state==="REJECTED") {
          const updated=await supabase.updateExecutionIntentStatus(intent.id,"REJECTED");
          if (!updated.ok || !updated.value.updated) return {ok:false,reason:"REJECTED_INTENT_RECOVERY_FAILED"};
          const event=await supabase.insertRecord("trade_events",{id:randomUUID(),execution_intent_id:intent.id,event_type:"EXECUTION_REJECTED_ON_RECOVERY",payload:lookup.value,occurred_at:new Date().toISOString()});
          if (!event.ok) return {ok:false,reason:"RECOVERY_AUDIT_FAILED"};
          continue;
        }
        return {ok:false,reason:"BROKER_LEDGER_REQUIRES_RECONCILIATION"};
      }
      if (lookup.status===404 && lookup.message==="NOT_FOUND" && intent.status==="CREATED") {
        const createdAt=Date.parse(String(intent.created_at??""));
        if (!Number.isFinite(createdAt) || Date.now()-createdAt<15000) return {ok:false,reason:"EXECUTION_INTENT_SETTLING"};
        const cancelled=await supabase.updateExecutionIntentStatus(intent.id,"CANCELLED");
        if (!cancelled.ok || !cancelled.value.updated) return {ok:false,reason:"UNSENT_INTENT_CANCELLATION_FAILED"};
        const event=await supabase.insertRecord("trade_events",{id:randomUUID(),execution_intent_id:intent.id,event_type:"UNSENT_INTENT_CANCELLED_ON_RECOVERY",payload:{reason:"BRIDGE_LEDGER_NOT_FOUND"},occurred_at:new Date().toISOString()});
        if (!event.ok) return {ok:false,reason:"RECOVERY_AUDIT_FAILED"};
        continue;
      }
      return {ok:false,reason:"EXECUTION_RESULT_UNKNOWN"};
    }
    return {ok:true};
  }
  let latestScanView=null;
  async function fetchScannerCandles(timeframe,count) {
    const intervals={M1:"1m",M5:"5m",M15:"15m",H1:"1h"};
    const seconds={M1:60,M5:300,M15:900,H1:3600};
    if(!intervals[timeframe])return {ok:false,message:"INVALID_TIMEFRAME"};
    let biquoteError="BIQUOTE_UNAVAILABLE";
    try {
      const base=typeof env.BIQUOTE_BASE_URL==="string"&&env.BIQUOTE_BASE_URL.trim()?env.BIQUOTE_BASE_URL.trim():"https://biquote.io";
      const endpoint=new URL("/api/XAUUSD/ohlc",base);
      if(!(endpoint.protocol==="https:"||(["localhost","127.0.0.1","::1"].includes(endpoint.hostname)&&endpoint.protocol==="http:"))||endpoint.username||endpoint.password)throw new Error("INVALID_BIQUOTE_BASE_URL");
      endpoint.searchParams.set("interval",intervals[timeframe]);
      endpoint.searchParams.set("limit",String(count));
      const response=await fetch(endpoint,{signal:AbortSignal.timeout(8000),headers:{accept:"application/json"}});
      if(!response.ok) biquoteError="BIQUOTE_HTTP_"+response.status;
      else {
        const payload=await response.json();
        const nowSeconds=Math.floor(Date.now()/1000),duration=seconds[timeframe];
        const rows=(Array.isArray(payload?.bars)?payload.bars:[]).map(bar=>{
          const opened=Date.parse(bar?.openTime);
          const values=[Number(bar?.open),Number(bar?.high),Number(bar?.low),Number(bar?.close)];
          return {opened,values,tickVolume:Number(bar?.tickVolume??bar?.volume??0),isOpen:bar?.isOpen===true};
        }).filter(row=>Number.isFinite(row.opened)&&row.opened>0&&row.values.every(value=>Number.isFinite(value)&&value>0)&&!row.isOpen&&Math.floor(row.opened/1000)+duration<=nowSeconds)
          .sort((a,b)=>a.opened-b.opened);
        const unique=rows.filter((row,index)=>index===0||row.opened!==rows[index-1].opened);
        if(unique.length>=35) {
          const candles=unique.slice(-count).map(row=>({symbol:"XAUUSD",timeframe,openTime:new Date(row.opened).toISOString(),closeTime:new Date(row.opened+duration*1000).toISOString(),open:row.values[0],high:row.values[1],low:row.values[2],close:row.values[3],tickVolume:Number.isFinite(row.tickVolume)?Math.max(0,Math.trunc(row.tickVolume)):0,isClosed:true}));
          return {ok:true,value:{candles},provider:"BIQUOTE"};
        }
        biquoteError="BIQUOTE_INSUFFICIENT_CLOSED_CANDLES";
      }
    } catch(error) { biquoteError=error?.name==="TimeoutError"||error?.name==="AbortError"?"BIQUOTE_TIMEOUT":"BIQUOTE_PARSE_OR_NETWORK_ERROR"; }
    // Scanner market data is intentionally independent of MT5. The bridge is an
    // execution adapter only; a provider outage must be reported, never hidden by
    // silently switching the scanner to broker candles.
    return {ok:false,message:biquoteError,providerErrors:{biquote:biquoteError}};
  }

  async function performScan(triggerType = "MANUAL") {
    if (scanInFlight) return { status:409, body:{error:"SCAN_ALREADY_RUNNING",message:"هناك دورة فحص قيد التنفيذ."} };
    scanInFlight = true;
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    let finalEntry = null;
    let dbRunCreated = false;
    const record = (status, reason, extra = {}) => {
      const entry = {id:runId,at:startedAt,triggerType,status,reason,...(supabase && !dbRunCreated ? {persistenceWarning:true} : {}),...extra};
      scannerRuns = [entry,...scannerRuns].slice(0,50);
      finalEntry = entry;
      return entry;
    };
    try {
      if (supabase) {
        const savedRun = await supabase.insertRecord("scanner_runs", {
          id:runId, trigger_type:triggerType, scheduled_at:triggerType==="SCHEDULED"?startedAt:null,
          started_at:startedAt, status:"RUNNING", correlation_id:runId
        });
        dbRunCreated = savedRun.ok;
      }
      // Analysis/signals use Biquote and must keep running when MT5 is offline.
      // Only an armed execution cycle is allowed to depend on the MT5 bridge.
      let health = null;
      if (autoTradingEnabled) {
        // If the bridge drops after execution was armed, disarm execution but
        // continue this scan in signal-only mode instead of losing the signal cycle.
        if (!bridge) {
          autoTradingEnabled=false;
          await queueNotificationToEnabled("تم إيقاف التنفيذ الآلي لـ XAUUSD لأن جسر MT5 غير مضبوط. سيستمر السكانر التحليلي عبر Biquote دون إرسال أوامر.","SYSTEM_ALERT","execution-disarmed-no-bridge:"+new Date().toISOString().slice(0,10));
        } else {
          const bridgeCheck = await bridge.health();
          if (!bridgeCheck.ok || bridgeCheck.value.state !== "CONNECTED" || bridgeCheck.value.environment !== executionEnvironment) {
            autoTradingEnabled=false;
            await queueNotificationToEnabled("تم إيقاف التنفيذ الآلي لـ XAUUSD لأن جسر MT5 غير جاهز. سيستمر السكانر عبر Biquote بإصدار التحليل والإشارات فقط.","SYSTEM_ALERT","execution-disarmed-bridge-unavailable:"+new Date().toISOString().slice(0,10));
          } else {
            health = bridgeCheck;
            const reconciliation=await reconcilePendingExecutionIntents(health.value);
            if (!reconciliation.ok) {
              autoTradingEnabled=false;
              await queueNotificationToEnabled("تم إيقاف التنفيذ الآلي لـ XAUUSD بسبب حاجة سجل التنفيذ إلى المصالحة: "+reconciliation.reason+". سيستمر التحليل دون إرسال أوامر.","SYSTEM_ALERT","execution-disarmed-reconciliation:"+new Date().toISOString().slice(0,10));
            }
          }
        }
      }
      const timeframes = ["M1","M5","M15","H1"];
      const fetched = await Promise.all(timeframes.map(async timeframe => [timeframe,await fetchScannerCandles(timeframe,timeframe==="M1"?120:60)]));
      const normalized = {};
      const freshness=scanFreshnessPolicy(triggerType);
      for (const [timeframe,result] of fetched) {
        if (!result.ok) {
          const entry=record("NO_ANALYSIS","MARKET_DATA_UNAVAILABLE",{timeframe,error:result.message,providerErrors:result.providerErrors||null});
          return {status:503,body:{error:"MARKET_DATA_UNAVAILABLE",message:"تعذر جلب شموع كافية من Biquote؛ لم يتم إنشاء إشارة.",run:entry}};
        }
        // Biquote is the scanner feed; MT5 is not a market-data fallback for analysis.
        // Freshness and closed-bar validation remain mandatory before analysis.
        const bars = normalizeClosedCandles(result.value.candles,timeframe,35);
        if (!bars.ok) {
          const entry=record("NO_ANALYSIS",bars.error,{timeframe});
          return {status:409,body:{error:bars.error,message:"بيانات السوق غير صالحة للتحليل.",run:entry}};
        }
        normalized[timeframe]=bars.value;
      }
      let managedOpenPositionCount=0;
      if (autoTradingEnabled) {
        const management = await manageOpenPositions(normalized,health.value);
        if (!management.ok) {
          autoTradingEnabled=false;
          const entry=record("RECONCILIATION_REQUIRED",management.reason);
          return {status:503,body:{error:"POSITION_MANAGER_NOT_READY",message:"تعذرت مصالحة أو حماية الصفقات المفتوحة؛ تم منع أي دخول جديد.",run:entry}};
        }
        managedOpenPositionCount=management.openPositionCount;
      }
      const now = new Date().toISOString();
      const analysis = analyzeClosedMarket({symbol:"XAUUSD",candles:normalized,now,maxM1AgeMs:freshness.maxM1AgeMs,minimumM1Bars:35});
      if (analysis.status === "NO_ANALYSIS") {
        const entry=record("NO_ANALYSIS",analysis.reason,{latestClosedBarTime:analysis.latestClosedBarTime});
        return {status:409,body:{error:analysis.reason,message:"البيانات غير كافية أو قديمة؛ لا توجد إشارة.",analysis,chartCandles:normalized.M1.slice(-60),run:entry}};
      }
      if (analysis.status === "WAIT") {
        const entry=record("WAIT",analysis.reason,{metrics:analysis.metrics});
        return {status:200,body:{status:"WAIT",message:"اكتمل التحليل الفني دون فرصة مطابقة؛ لم يتم إصدار إشارة.",analysis,chartCandles:normalized.M1.slice(-60),run:entry}};
      }
      const evidence = analysis.evidence[0];
      const candidateKey = evidence.strategyId + ":" + evidence.direction + ":" + analysis.latestClosedBarTime;
      let candidateId = randomUUID();
      let decisionId = randomUUID();
      let assessmentId = randomUUID();
      let existingCandidate = null;
      if (supabase) {
        const candidatePayload = {
          id:candidateId,candidate_key:candidateKey,strategy_id:evidence.strategyId,symbol:"XAUUSD",
          direction:evidence.direction,entry_price:evidence.entryPrice,stop_loss:evidence.stopLoss,
          take_profit:evidence.takeProfit,evidence:analysis.evidence,status:"AI_PENDING",
          created_at:now,expires_at:evidence.expiresAt
        };
        const savedCandidate = await supabase.insertRecord("strategy_candidates",candidatePayload);
        if (!savedCandidate.ok && savedCandidate.errorCode === "ALREADY_EXISTS") {
          existingCandidate = await supabase.findCandidateByKey(candidateKey).catch(()=>null);
          if (!existingCandidate || typeof existingCandidate.id !== "string") {
            const entry=record("FAILED","CANDIDATE_DEDUPE_LOOKUP_FAILED");
            return {status:503,body:{error:"PERSISTENCE_FAILED",message:"تعذر التحقق من الفرصة المكررة؛ لم يتم التنفيذ.",run:entry}};
          }
          if (existingCandidate.status === "DECIDED") {
            const entry=record("DUPLICATE_CANDIDATE","ALREADY_PROCESSED",{candidateId:existingCandidate.id});
            return {status:200,body:{status:"DUPLICATE_CANDIDATE",message:"هذه الشمعة تمت معالجتها سابقًا؛ تم منع تكرار القرار والتنفيذ.",run:entry}};
          }
          candidateId = existingCandidate.id;
        } else if (!savedCandidate.ok) {
          const entry=record("FAILED","CANDIDATE_PERSIST_FAILED");
          return {status:503,body:{error:"PERSISTENCE_FAILED",message:"تعذر حفظ الفرصة؛ لن يتم اعتماد قرار أو تنفيذ.",run:entry}};
        }
      }
      if (!aiProvider) {
        await queueNotificationToEnabled("تنبيه النظام: مرشح فني لـ XAUUSD لم يُعتمد لأن مزود AI غير مهيأ. لا يوجد أمر تداول.","SYSTEM_ALERT","ai-not-configured:"+candidateKey);
        const entry=record("AI_NOT_CONFIGURED","TECHNICAL_CANDIDATE_ONLY",{metrics:analysis.metrics});
        return {status:503,body:{error:"AI_NOT_CONFIGURED",message:"تم رصد مرشح فني، لكن AI غير مهيأ. لا يتم اعتماد اتجاه أو إرسال أمر.",analysis:{...analysis,evidence:analysis.evidence.map(({entryPrice,stopLoss,takeProfit,direction,strategyId})=>({entryPrice,stopLoss,takeProfit,direction,strategyId}))},chartCandles:normalized.M1.slice(-60),run:entry}};
      }
      let assessment;
      try {
        assessment = await aiProvider.assess({symbol:"XAUUSD",evidence:analysis.evidence,now,marketContext:{recentClosedM1:normalized.M1.slice(-20).map(bar=>({time:bar.closeTime,open:bar.open,high:bar.high,low:bar.low,close:bar.close}))}});
        aiProbePassed = true;
      } catch (error) {
        aiProbePassed = false;
        throw error;
      }
      if (Date.parse(assessment.expiresAt) <= Date.now() || Date.parse(evidence.expiresAt) <= Date.now()) {
        if (supabase) await supabase.updateRecord("strategy_candidates",candidateId,{status:"EXPIRED"});
        const entry=record("EXPIRED","AI_ASSESSMENT_EXPIRED");
        return {status:409,body:{error:"ASSESSMENT_EXPIRED",message:"انتهت صلاحية الأدلة أثناء انتظار AI؛ تم منع التنفيذ.",run:entry}};
      }
      const decision = coordinateTechnicalAndAI(analysis.evidence,assessment);
      if (supabase) {
        const savedAssessment = await supabase.insertRecord("ai_assessments",{
          id:assessmentId,candidate_id:candidateId,provider_id:assessment.providerId,model_id:assessment.modelId,
          outcome:assessment.outcome,rationale:assessment.rationale,rationale_codes:assessment.rationaleCodes,
          assessed_at:assessment.assessedAt,expires_at:assessment.expiresAt
        });
        if (!savedAssessment.ok) {
          const entry=record("FAILED","AI_ASSESSMENT_PERSIST_FAILED");
          return {status:503,body:{error:"PERSISTENCE_FAILED",message:"تعذر حفظ تقييم AI؛ لن يتم اعتماد القرار أو التنفيذ.",run:entry}};
        }
        const technicalOutcome = evidence.direction;
        const savedDecision = await supabase.insertRecord("trade_decisions",{
          id:decisionId,candidate_id:candidateId,ai_assessment_id:assessmentId,
          technical_outcome:technicalOutcome,ai_outcome:assessment.outcome,outcome:decision.outcome,
          reason_codes:decision.reasonCodes,decided_at:now,expires_at:evidence.expiresAt
        });
        if (!savedDecision.ok) {
          const entry=record("FAILED","TRADE_DECISION_PERSIST_FAILED");
          return {status:503,body:{error:"PERSISTENCE_FAILED",message:"تعذر حفظ القرار؛ لن يتم التنفيذ.",run:entry}};
        }
        const updatedCandidate = await supabase.updateRecord("strategy_candidates",candidateId,{status:"DECIDED"});
        if (!updatedCandidate.ok || !updatedCandidate.value.updated) {
          const entry=record("FAILED","CANDIDATE_STATE_PERSIST_FAILED");
          return {status:503,body:{error:"PERSISTENCE_FAILED",message:"تعذر تثبيت حالة الفرصة؛ تم منع التنفيذ.",run:entry}};
        }
      }
      let notification = {sent:0,failed:0,reason:"NO_DIRECTIONAL_DECISION"};
      if (decision.outcome === "BUY" || decision.outcome === "SELL") {
        notification = await queueNotificationToEnabled(
          "XAUUSD "+decision.outcome+" — قرار تحليلي بعد توافق التحليل الفني وAI. هذه ليست رسالة تأكيد تنفيذ؛ راجع حالة الوسيط في لوحة التحكم.",
          "TRADE_DECISION","decision:"+candidateKey+":"+decision.outcome
        );
      }
      let execution = "NOT_SUBMITTED";
      let executionDetail = "التنفيذ الآلي غير مفعّل.";
      if ((decision.outcome === "BUY" || decision.outcome === "SELL") && autoTradingEnabled) {
        if (notification.failed > 0 || notification.reason === "OUTBOX_UNAVAILABLE") {
          autoTradingEnabled=false;
          const entry=record("FAILED","NOTIFICATION_OUTBOX_UNAVAILABLE");
          return {status:503,body:{error:"NOTIFICATION_OUTBOX_UNAVAILABLE",message:"تعذر ضمان تسجيل تنبيه القرار؛ تم منع إرسال الأمر.",decision,execution:"NOT_SUBMITTED",run:entry}};
        }
        if (managedOpenPositionCount >= 1) {
          const entry=record("SKIPPED_OPEN_POSITION_EXISTS","MAX_ONE_BOT_POSITION");
          return {status:200,body:{status:"OPEN_POSITION_EXISTS",message:"يوجد مركز XAUUSD مفتوح للبوت؛ تمت إدارته ومنع فتح مركز ثانٍ.",decision,execution:"NOT_SUBMITTED",run:entry}};
        }
        await hydrateSettings();
        if (!supabase || !dbRunCreated || !riskSettings) {
          const entry=record("FAILED","EXECUTION_PREREQUISITES_MISSING");
          return {status:503,body:{error:"EXECUTION_NOT_READY",message:"متطلبات التخزين الدائم أو المخاطرة غير جاهزة؛ لم يتم إرسال الأمر.",run:entry}};
        }
        const liveQuote = await bridge.quote();
        if (!liveQuote.ok) {
          const entry=record("FAILED","LIVE_QUOTE_UNAVAILABLE");
          return {status:503,body:{error:"LIVE_QUOTE_UNAVAILABLE",message:"تعذر جلب سعر حالي من MT5؛ لم يتم إرسال الأمر.",run:entry}};
        }
        const tickAgeMs = Date.now() - Date.parse(liveQuote.value.tickTime);
        if (!Number.isFinite(tickAgeMs) || tickAgeMs < 0 || tickAgeMs > 15000) {
          const entry=record("RISK_REJECTED","STALE_EXECUTION_QUOTE");
          return {status:409,body:{status:"RISK_REJECTED",message:"سعر MT5 غير حديث؛ تم منع التنفيذ.",execution:"NOT_SUBMITTED",run:entry}};
        }
        const symbolSpec = await bridge.symbolSpec();
        if (!symbolSpec.ok) {
          const entry=record("FAILED","BROKER_SPEC_UNAVAILABLE");
          return {status:503,body:{error:"RISK_NOT_READY",message:"تعذر جلب مواصفات XAUUSD من الوسيط؛ لم يتم إرسال الأمر.",run:entry}};
        }
        if (Date.parse(evidence.expiresAt) <= Date.now()) {
          const entry=record("EXPIRED","EVIDENCE_EXPIRED_BEFORE_RISK");
          return {status:409,body:{error:"ASSESSMENT_EXPIRED",message:"انتهت صلاحية الفرصة قبل حساب المخاطرة؛ لم يتم إرسال الأمر.",run:entry}};
        }
        // Manual analysis may use a 70-second closed candle, but execution always requires a <=20-second signal.
        const evidenceAgeMs=Date.now()-Date.parse(evidence.createdAt);
        if (triggerType==="MANUAL" && (!Number.isFinite(evidenceAgeMs) || evidenceAgeMs<0 || evidenceAgeMs>20000)) {
          const entry=record("RISK_REJECTED","MANUAL_SIGNAL_TOO_OLD_FOR_EXECUTION",{evidenceAgeMs});
          return {status:409,body:{status:"RISK_REJECTED",message:"يمكن تحليل الشمعة يدويًا حتى 70 ثانية، لكن التنفيذ يتطلب إشارة أحدث من 20 ثانية. لم يُرسل أمر.",execution:"NOT_SUBMITTED",run:entry}};
        }
        const timeBlock=tradingTimeBlock(env);
        if (timeBlock) {
          const entry=record("RISK_REJECTED",timeBlock);
          return {status:409,body:{status:"RISK_REJECTED",message:timeBlock==="ROLLOVER_BLACKOUT"?"فترة إغلاق/تبديل جلسة السوق؛ تم منع الدخول الجديد.":"فترة أخبار عالية التأثير مُعدّة على الخادم؛ تم منع الدخول الجديد.",execution:"NOT_SUBMITTED",run:entry}};
        }
        const newsBlock=await economicCalendarBlock(env);
        if (newsBlock) {
          autoTradingEnabled=false;
          const entry=record("RISK_REJECTED",newsBlock);
          return {status:newsBlock==="HIGH_IMPACT_NEWS_BLACKOUT"?409:503,body:{status:"RISK_REJECTED",message:newsBlock==="HIGH_IMPACT_NEWS_BLACKOUT"?"خبر أمريكي عالي التأثير ضمن نافذة الحظر؛ تم منع الدخول.":"تقويم الأخبار غير متاح أو غير مضبوط؛ تم إيقاف التنفيذ الآلي احترازيًا.",execution:"NOT_SUBMITTED",run:entry}};
        }
        const dailyGuard=dailyLossGuardConfig({},riskSettings);
        if (!dailyGuard) {
          autoTradingEnabled=false;
          const entry=record("RISK_REJECTED","DAILY_RISK_LIMITS_NOT_CONFIGURED");
          return {status:409,body:{status:"RISK_REJECTED",message:"تم إيقاف التنفيذ الآلي: احفظ حد الخسارة اليومية وعدد الخسائر المتتالية من قسم المخاطر في لوحة التحكم.",execution:"NOT_SUBMITTED",run:entry}};
        }
        const dailyRisk=await bridge.dailyRisk();
        if (!dailyRisk.ok || dailyRisk.value.accountLogin!==String(health.value.accountLogin) ||
            dailyRisk.value.source!=="MT5_CLOSED_DEALS_BOT_MAGIC" ||
            !Number.isFinite(dailyRisk.value.balance) || dailyRisk.value.balance<=0 ||
            !Number.isFinite(dailyRisk.value.dailyNetPnl) || !Number.isInteger(dailyRisk.value.consecutiveLosses) ||
            dailyRisk.value.consecutiveLosses<0) {
          autoTradingEnabled=false;
          const entry=record("RISK_REJECTED","DAILY_RISK_HISTORY_UNAVAILABLE");
          return {status:503,body:{status:"RISK_REJECTED",message:"تعذر التحقق من سجل الصفقات المغلقة لدى MT5؛ تم إيقاف التنفيذ الآلي احترازيًا.",execution:"NOT_SUBMITTED",run:entry}};
        }
        const dailyLossPercent=Math.max(0,-dailyRisk.value.dailyNetPnl)/dailyRisk.value.balance*100;
        if (dailyLossPercent>=dailyGuard.maxDailyLossPercent || dailyRisk.value.consecutiveLosses>=dailyGuard.maxConsecutiveLosses) {
          autoTradingEnabled=false;
          const reason=dailyLossPercent>=dailyGuard.maxDailyLossPercent?"DAILY_LOSS_LIMIT_REACHED":"CONSECUTIVE_LOSS_LIMIT_REACHED";
          const entry=record("RISK_REJECTED",reason,{dailyLossPercent,dailyNetPnl:dailyRisk.value.dailyNetPnl,consecutiveLosses:dailyRisk.value.consecutiveLosses});
          await queueNotificationToEnabled("تم إيقاف التنفيذ الآلي لـ XAUUSD بسبب حد المخاطرة: "+reason+". خسارة اليوم "+dailyLossPercent.toFixed(2)+"%، سلسلة الخسائر "+dailyRisk.value.consecutiveLosses+".","RISK_GUARD", "risk-guard:"+dailyRisk.value.dayStartUtc+":"+reason);
          return {status:409,body:{status:"RISK_REJECTED",message:"تم إيقاف التنفيذ الآلي بعد تجاوز حد خسارة اليوم أو عدد الخسائر المتتالية.",dailyLossPercent,dailyNetPnl:dailyRisk.value.dailyNetPnl,consecutiveLosses:dailyRisk.value.consecutiveLosses,execution:"NOT_SUBMITTED",run:entry}};
        }
        const entryPrice=decision.direction==="BUY"?liveQuote.value.ask:liveQuote.value.bid;
        const spreadPrice=liveQuote.value.ask-liveQuote.value.bid;
        if (!Number.isFinite(spreadPrice) || spreadPrice<0) {
          const entry=record("RISK_REJECTED","INVALID_LIVE_SPREAD");
          return {status:409,body:{status:"RISK_REJECTED",message:"قيمة السبريد من MT5 غير صالحة؛ تم منع التنفيذ.",execution:"NOT_SUBMITTED",run:entry}};
        }
        const m1=normalized.M1;
        const atrValues=atr(m1.map(bar=>bar.high),m1.map(bar=>bar.low),m1.map(bar=>bar.close),14);
        const currentAtr=atrValues[atrValues.length-1];
        if (!Number.isFinite(currentAtr) || currentAtr<=0) {
          const entry=record("RISK_REJECTED","ATR_UNAVAILABLE_AT_EXECUTION");
          return {status:409,body:{status:"RISK_REJECTED",message:"تعذر حساب ATR حديث؛ تم منع التنفيذ.",execution:"NOT_SUBMITTED",run:entry}};
        }
        // Rebuild protection from the executable quote, not the earlier candle close.
        const stopDistance=1.5*currentAtr+spreadPrice;
        if (spreadPrice>stopDistance*0.125 || currentAtr<spreadPrice*2) {
          const entry=record("RISK_REJECTED","SPREAD_TOO_WIDE_FOR_ATR");
          return {status:409,body:{status:"RISK_REJECTED",message:"السبريد مرتفع نسبةً إلى ATR ووقف الخسارة؛ تم منع الدخول.",spreadPrice,atr:currentAtr,stopDistance,execution:"NOT_SUBMITTED",run:entry}};
        }
        const digits=symbolSpec.value.priceDigits;
        const roundPrice=value=>Number(value.toFixed(digits));
        const stopLoss=roundPrice(decision.direction==="BUY"?entryPrice-stopDistance:entryPrice+stopDistance);
        // Preserve the configured minimum RR using the rounded, executable SL distance.
        // One tick of headroom prevents price rounding from nudging the ratio below the threshold.
        const actualStopDistance=Math.abs(entryPrice-stopLoss);
        const targetDistance=Math.max(3*currentAtr,(actualStopDistance+symbolSpec.value.tickSize)*riskSettings.minimumRiskRewardRatio);
        const takeProfit=roundPrice(decision.direction==="BUY"?entryPrice+targetDistance:entryPrice-targetDistance);
        const prepared = prepareExecutionIntent({
          id:randomUUID(),idempotencyKey:candidateKey+":"+executionEnvironment,opportunityId:candidateId,decisionId,
          environment:executionEnvironment,settings:riskSettings,
          trade:{direction:decision.direction,entryPrice,stopLoss,takeProfit,minimumRiskRewardRatio:riskSettings.minimumRiskRewardRatio},
          spec:symbolSpec.value,now
        });
        if (!prepared.accepted) {
          const entry=record("RISK_REJECTED",prepared.reason);
          return {status:200,body:{status:"RISK_REJECTED",message:"رفض مدير المخاطر الأمر قبل الإرسال.",decision,execution:"NOT_SUBMITTED",risk:prepared,run:entry}};
        }
        const storedIntent = await supabase.createIfAbsent(prepared.intent);
        if (!storedIntent.ok) {
          const entry=record("FAILED","EXECUTION_INTENT_PERSIST_FAILED");
          return {status:503,body:{error:"PERSISTENCE_FAILED",message:"تعذر حفظ نية التنفيذ؛ لم يتم إرسال الأمر.",run:entry}};
        }
        if (!storedIntent.value.created) {
          const entry=record("RECONCILIATION_REQUIRED","EXECUTION_INTENT_ALREADY_EXISTS");
          return {status:409,body:{status:"RECONCILIATION_REQUIRED",message:"نية تنفيذ موجودة مسبقًا؛ تم منع إعادة الإرسال الآلي.",execution:"NOT_SUBMITTED",run:entry}};
        }
        if (Date.parse(evidence.expiresAt) <= Date.now()) {
          await supabase.updateExecutionIntentStatus(prepared.intent.id,"CANCELLED");
          const entry=record("EXPIRED","EVIDENCE_EXPIRED_BEFORE_SUBMISSION");
          return {status:409,body:{error:"ASSESSMENT_EXPIRED",message:"انتهت صلاحية الفرصة بعد حفظ نية التنفيذ؛ تم إلغاء الإرسال.",execution:"NOT_SUBMITTED",run:entry}};
        }
        const submitted = await bridge.submitOrder({intent:storedIntent.value.intent});
        if (!submitted.ok) {
          const targetStatus = submitted.errorCode === "RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" : submitted.errorCode === "UNAVAILABLE" ? "UNKNOWN" : "REJECTED";
          await supabase.updateExecutionIntentStatus(prepared.intent.id,targetStatus);
          execution = targetStatus;
          executionDetail = submitted.message;
          const entry=record(targetStatus,submitted.errorCode);
          return {status:submitted.errorCode==="RECONCILIATION_REQUIRED"?202:503,body:{status:targetStatus,message:"نتيجة الوسيط غير مؤكدة أو مرفوضة؛ لا إعادة إرسال تلقائية.",decision,execution,executionDetail,run:entry}};
        }
        if (submitted.value.state === "CONFIRMED") {
          const savedStatus = await supabase.updateExecutionIntentStatus(prepared.intent.id,"CONFIRMED");
          const accountLogin = health.value.accountLogin;
          let orderPersisted = false;
          if (accountLogin && submitted.value.brokerOrderId) {
            const order = await supabase.insertRecord("broker_orders",{
              id:randomUUID(),execution_intent_id:prepared.intent.id,account_login:String(accountLogin),
              broker_order_id:submitted.value.brokerOrderId,status:"CONFIRMED",
              request_payload:{symbol:"XAUUSD",direction:decision.direction,volume:prepared.intent.volume,stopLoss:prepared.intent.stopLoss,takeProfit:prepared.intent.takeProfit},
              response_payload:submitted.value,created_at:new Date().toISOString(),updated_at:new Date().toISOString()
            });
            orderPersisted = order.ok;
          }
          const auditEvent = await supabase.insertRecord("trade_events",{id:randomUUID(),execution_intent_id:prepared.intent.id,event_type:executionEnvironment+"_ORDER_CONFIRMED",payload:{brokerOrderId:submitted.value.brokerOrderId,orderPersisted},occurred_at:new Date().toISOString()});
          execution = "CONFIRMED";
          const executionAlert = await queueNotificationToEnabled("تم تأكيد أمر XAUUSD على حساب MT5 Demo. الاتجاه: "+decision.direction+"، الحجم: "+prepared.intent.volume+"، رقم الوسيط: "+submitted.value.brokerOrderId+".","EXECUTION_CONFIRMED","execution-confirmed:"+prepared.intent.id);
          executionDetail = savedStatus.ok && orderPersisted && auditEvent.ok
            ? "تم تأكيد أمر Demo وحفظ سجل التنفيذ."+(executionAlert.failed?" تعذر تسليم بعض التنبيهات.":"")
            : "تم تأكيد أمر Demo، لكن بعض سجلات التخزين أو التدقيق لم تُحفظ. يلزم فحص السجل؛ لا تعِد الإرسال.";
        } else if (submitted.value.state === "REJECTED") {
          await supabase.updateExecutionIntentStatus(prepared.intent.id,"REJECTED");
          execution = "REJECTED"; executionDetail = submitted.value.error ?? "رفض الوسيط الأمر.";
          await queueNotificationToEnabled("رفض وسيط MT5 أمر XAUUSD على Demo. راجع سجل التنفيذ؛ لم تتم إعادة المحاولة تلقائيًا.","EXECUTION_REJECTED","execution-rejected:"+prepared.intent.id);
        } else {
          await supabase.updateExecutionIntentStatus(prepared.intent.id,"RECONCILIATION_REQUIRED");
          execution = "RECONCILIATION_REQUIRED"; executionDetail = "النتيجة غامضة؛ إعادة الإرسال محظورة.";
        }
      }
      const entry=record(decision.outcome,"AI_ASSESSMENT_COMPLETED",{reasonCodes:decision.reasonCodes,technicalStatus:analysis.status,aiOutcome:assessment.outcome,execution});
      return {
        status:200,
        body:{
          status:decision.outcome,
          message:execution==="CONFIRMED" ? "تم تأكيد أمر Demo من الوسيط." : decision.outcome==="BUY"||decision.outcome==="SELL"
            ? "قرار تحليلي متوافق؛ "+executionDetail
            : "لم يتم اعتماد دخول بسبب الانتظار أو التعارض أو الرفض.",
          reasonCodes:decision.reasonCodes,analysis,assessment,decision,notification,execution,executionDetail,chartCandles:normalized.M1.slice(-60),run:entry
        }
      };
    } catch {
      await queueNotificationToEnabled("تنبيه النظام: فشلت دورة فحص XAUUSD. راجع سجل النظام قبل إعادة المحاولة.","SYSTEM_ALERT","scan-failure:"+Math.floor(Date.now()/300000));
      const entry=record("FAILED","UNEXPECTED_SCAN_FAILURE");
      return {status:503,body:{error:"SCAN_FAILED",message:"فشل الفحص؛ تم تسجيله دون إعلان نجاح.",run:entry}};
    } finally {
      if (supabase && dbRunCreated && finalEntry) {
        const status = finalEntry.status === "FAILED" || finalEntry.status === "RECONCILIATION_REQUIRED" ? "FAILED"
          : finalEntry.status === "NOT_READY" || finalEntry.status === "NO_ANALYSIS" || finalEntry.status === "AI_NOT_CONFIGURED" ? "SKIPPED" : "COMPLETED";
        await supabase.updateRecord("scanner_runs",runId,{status,completed_at:new Date().toISOString(),error_code:status==="FAILED"?finalEntry.reason:null}).catch(()=>undefined);
      }
      scanInFlight = false;
    }
  }

  async function runAndStoreScan(triggerType) {
    const result=await performScan(triggerType);
    if (result.body?.error!=="SCAN_ALREADY_RUNNING") latestScanView={statusCode:result.status,updatedAt:new Date().toISOString(),body:result.body};
    return result;
  }
  async function dailyRiskGuardStatus() {
    const limits=dailyLossGuardConfig({},riskSettings);
    if (!limits) return {ok:false,code:"DAILY_RISK_LIMITS_NOT_CONFIGURED"};
    if (!bridge) return {ok:false,code:"MT5_BRIDGE_NOT_CONFIGURED"};
    const health=await bridge.health();
    if (!health.ok || health.value.state!=="CONNECTED" || health.value.environment!==executionEnvironment || !health.value.accountLogin) {
      return {ok:false,code:"MT5_ACCOUNT_NOT_CONFIRMED"};
    }
    const result=await bridge.dailyRisk();
    if (!result.ok) return {ok:false,code:"DAILY_RISK_HISTORY_UNAVAILABLE"};
    return evaluateDailyRiskGuard({},result.value,health.value.accountLogin,riskSettings);
  }
  async function enforceScheduledDailyRiskGuard() {
    if (!autoTradingEnabled) return true;
    let status;
    try { status=await dailyRiskGuardStatus(); }
    catch { status={ok:false,code:"DAILY_RISK_HISTORY_UNAVAILABLE"}; }
    if (status.ok) return true;
    autoTradingEnabled=false;
    const at=new Date().toISOString();
    scannerRuns=[{id:randomUUID(),at,triggerType:"RISK_MONITOR",status:"RISK_REJECTED",reason:status.code,...(status.dailyLossPercent!==undefined?{dailyLossPercent:status.dailyLossPercent}:{}),...(status.consecutiveLosses!==undefined?{consecutiveLosses:status.consecutiveLosses}:{})},...scannerRuns].slice(0,50);
    latestScanView={statusCode:409,updatedAt:at,body:{status:"RISK_REJECTED",error:status.code,message:"تم إيقاف التنفيذ الآلي بواسطة مراقب المخاطر. لا يتم إغلاق المراكز المفتوحة تلقائيًا.",execution:"NOT_SUBMITTED",...status}};
    await queueNotificationToEnabled("تم إيقاف التنفيذ الآلي لـ XAUUSD بواسطة مراقب المخاطر: "+status.code+". راجع سجل MT5 قبل إعادة التفعيل.","RISK_GUARD","risk-monitor:"+status.code+":"+new Date().toISOString().slice(0,10));
    return false;
  }
  const outboxTimer = supabase && telegram.configured ? setInterval(()=>{ void drainOutbox(); },15000) : null;
  outboxTimer?.unref?.();
  let telegramPollingInFlight=false;
  async function pollTelegramUpdates() {
    if (!telegram.configured || telegramPollingInFlight) return;
    telegramPollingInFlight=true;
    try {
      const chats=await telegram.discoverChats();
      if (supabase) {
        for (const chat of chats) {
          try { await supabase.upsertTelegramChat({chatId:chat.chatId,displayName:chat.title,discoveredAt:chat.lastSeenAt}); }
          catch { /* Continue polling; storage errors remain visible in dashboard actions. */ }
        }
      }
    } catch {
      // Explicit discover/test actions provide visible error details without crashing the server.
    } finally { telegramPollingInFlight=false; }
  }
  const telegramPollTimer=telegram.configured?setInterval(()=>{void pollTelegramUpdates();},5000):null;
  telegramPollTimer?.unref?.();
  if (telegram.configured) setTimeout(()=>{void pollTelegramUpdates();},250).unref?.();
  const server = createServer(async (req,res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const isRelayRoute = url.pathname.startsWith("/api/mt5/relay/");
    if (isRelayRoute) {
      const supplied = req.headers["x-bridge-token"];
      if (!relayToken || typeof supplied !== "string" || supplied.length !== relayToken.length || !timingSafeEqual(Buffer.from(supplied),Buffer.from(relayToken))) return sendJson(res,401,{error:"UNAUTHORIZED"});
      if (method === "GET" && url.pathname === "/api/mt5/relay/poll") {
        const job = relayJobs.shift() ?? null;
        return sendJson(res,200,{job});
      }
      if (method === "POST" && url.pathname === "/api/mt5/relay/result") {
        let body; try { body=await readJson(req,1_100_000); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY"}); }
        if (typeof body.id !== "string" || !Number.isInteger(body.status) || body.status<100 || body.status>599 || !body.body || typeof body.body!=="object") return sendJson(res,400,{error:"INVALID_RESULT"});
        const waiter=relayWaiters.get(body.id);
        if (!waiter) return sendJson(res,404,{error:"UNKNOWN_JOB"});
        relayWaiters.delete(body.id); waiter({status:body.status,body:body.body});
        return sendJson(res,200,{ok:true});
      }
      if ((method === "GET" || method === "POST") && url.pathname.startsWith("/api/mt5/relay/proxy/")) {
        const path = url.pathname.slice("/api/mt5/relay/proxy".length) || "/";
        const allowedPath = /^\/(health|market\/(quote|spec|candles)|orders(\/lookup)?|positions(\/modify|\/close)?|environment|risk\/daily)(\?.*)?$/.test(path+url.search);
        if (!allowedPath || path.startsWith("//") || path.includes("..") || path.includes("\\\\") || /[\\r\\n]/.test(path)) return sendJson(res,400,{error:"INVALID_RELAY_PATH"});
        if (relayJobs.length >= 100 || relayWaiters.size >= 100) return sendJson(res,503,{error:"MT5_RELAY_BUSY"});
        let body = null;
        if (method === "POST") { try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY"}); } }
        const id = randomUUID();
        const result = await new Promise(resolve => {
          // Must outlive the local bridge's 20-second request timeout and result delivery.
          const timeout = setTimeout(() => {
            if (relayWaiters.delete(id)) {
              // Remove jobs that have not yet been picked up, preventing stale UNKNOWN_JOB results.
              const queuedIndex = relayJobs.findIndex(job => job.id === id);
              if (queuedIndex !== -1) relayJobs.splice(queuedIndex, 1);
              resolve(null);
            }
          }, 30000);
          relayWaiters.set(id, value => { clearTimeout(timeout); resolve(value); });
          relayJobs.push({id,path:path+url.search,method,body});
        });
        if (!result) return sendJson(res,503,{error:"MT5_RELAY_TIMEOUT",message:"Windows relay agent did not respond in time."});
        return sendJson(res,result.status,result.body);
      }
      return sendJson(res,404,{error:"NOT_FOUND"});
    }
    if (method === "GET" && url.pathname === "/api/market/candles") {
      const intervals={M1:"1m",M5:"5m",M15:"15m",H1:"1h"}, tf=(url.searchParams.get("timeframe")||"M1").toUpperCase();
      if(!intervals[tf])return sendJson(res,400,{error:"INVALID_TIMEFRAME"});
      const n=Number(url.searchParams.get("count")||300),count=Number.isInteger(n)?Math.max(50,Math.min(1000,n)):300;
      try {
        const r=await fetch("https://biquote.io/api/XAUUSD/ohlc?interval="+intervals[tf]+"&limit="+count,{signal:AbortSignal.timeout(8000)});
        if(r.ok){const d=await r.json();const candles=(Array.isArray(d.bars)?d.bars:[]).map(b=>({time:Math.floor(Date.parse(b.openTime)/1000),open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),isOpen:Boolean(b.isOpen)})).filter(b=>Number.isFinite(b.time)&&[b.open,b.high,b.low,b.close].every(Number.isFinite)).sort((x,y)=>x.time-y.time).filter((b,i,x)=>!i||b.time>x[i-1].time);
          if(candles.length>=35)return sendJson(res,200,{ok:true,provider:"BIQUOTE",symbol:"XAUUSD",timeframe:tf,count:candles.length,candles,updatedAt:new Date().toISOString()});}
      }catch{}
      if(bridge){const r=await bridge.candles(tf,count);if(r.ok){const candles=(r.value.candles||[]).map(b=>({time:Math.floor(Date.parse(b.openTime||b.time)/1000),open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close)})).filter(b=>Number.isFinite(b.time)&&[b.open,b.high,b.low,b.close].every(Number.isFinite)).sort((x,y)=>x.time-y.time);if(candles.length>=35)return sendJson(res,200,{ok:true,provider:"MT5_FALLBACK",symbol:"XAUUSD",timeframe:tf,count:candles.length,candles,updatedAt:new Date().toISOString()});}}
      return sendJson(res,503,{error:"MARKET_DATA_UNAVAILABLE",message:"تعذر جلب شموع كافية من Biquote ومن مصدر MT5 البديل."});
    }
    if (method === "POST" && url.pathname === "/api/mt5/demo-execute-signal") {
      await hydrateSettings();
      if(executionEnvironment!=="DEMO")return sendJson(res,403,{error:"DEMO_ACCOUNT_REQUIRED",message:"هذا الزر يعمل على Demo فقط؛ اختر Demo أولًا."});
      if(!bridge||!aiProvider||!supabase||!riskSettings)return sendJson(res,409,{error:"EXECUTION_PREREQUISITES_MISSING",message:"يلزم اتصال MT5 Demo وإعداد AI والمخاطرة والتخزين الدائم قبل تنفيذ الإشارة."});
      if(autoTradingEnabled)return sendJson(res,409,{error:"MANUAL_EXECUTION_CONFLICT",message:"أوقف التنفيذ الآلي قبل طلب تنفيذ يدوي مستقل لتجنب تداخل الأوامر."});
      if(scanInFlight)return sendJson(res,409,{error:"SCAN_ALREADY_RUNNING",message:"هناك دورة فحص قيد التنفيذ."});
      const health=await bridge.health();
      if(!health.ok||health.value.state!=="CONNECTED"||health.value.environment!=="DEMO"||health.value.executionReady!==true||!health.value.accountLogin)
        return sendJson(res,403,{error:"DEMO_ACCOUNT_NOT_READY",message:"لم يؤكد الجسر حساب Demo جاهزًا للتنفيذ."});
      autoTradingEnabled=true;
      try {
        const result=await runAndStoreScan("MANUAL");
        return sendJson(res,result.status,result.body);
      } finally {
        autoTradingEnabled=false;
      }
    }
    if (method === "GET" && url.pathname === "/api/health") {
      await hydrateSettings();
      let databaseState = "NOT_CONFIGURED";
      if (supabase) { try { await supabase.readCurrent(); databaseState = "CONNECTED"; } catch { databaseState = "DISCONNECTED"; } }
      let bridgeHealth = null;
      if (bridge) { const result=await bridge.health(); if (result.ok) bridgeHealth=result.value; }
      const marketState = "BIQUOTE_PRIMARY";
      return sendJson(res,200,{
        marketData:{state:marketState,label:"Biquote · مصدر بيانات السكانر",reason:"التحليل والإشارات تعتمد على Biquote؛ جسر MT5 مطلوب للتنفيذ وإدارة الصفقات فقط."},
        mt5:{state:!bridge?"NOT_CONFIGURED":bridgeHealth?.state??"NOT_READY",label:bridgeHealth?.state==="CONNECTED"?"MT5 "+executionEnvironment+" متصل":"MT5 غير متصل",reason:bridgeHealth?.reason??"جسر MT5 غير مضبوط؛ إشارات Biquote لا تتوقف بسببه."},
        ai:{state:!aiConfigured?"NOT_CONFIGURED":aiProbePassed?"CONNECTED":"CONFIGURED_NOT_TESTED",label:!aiConfigured?"لم يتم الاتصال":aiProbePassed?"AI متصل":"إعدادات موجودة · الاتصال يحتاج اختبارًا"},
        database:{state:databaseState,label:databaseState==="CONNECTED"?"Supabase متصل":"Supabase غير متصل"},
        telegram:{state:telegram.configured?"CONFIGURED":"NOT_CONFIGURED",label:telegram.configured?"البوت مهيأ":"التنبيهات غير جاهزة"},
        scanner:{state:scannerEnabled?"CONNECTED":aiProvider?"READY_TO_ENABLE":"NOT_READY",label:scannerEnabled?"السكانر مفعّل":aiProvider?"السكانر جاهز للتفعيل":"السكانر يحتاج إعداد AI",reason:scannerEnabled?"يفحص كل 60 ثانية باستخدام Biquote؛ التنفيذ منفصل ويحتاج MT5.":aiProvider?"يتطلب تفعيل السكانر؛ لا يحتاج اتصال MT5 لإصدار الإشارات.":"اضبط مزود AI قبل تفعيل تحليل الإشارات.",nextScanAt:nextScheduledScanAt?new Date(nextScheduledScanAt).toISOString():null},
        execution:{state:autoTradingEnabled?(executionEnvironment==="LIVE"?"ARMED_LIVE":"ARMED_DEMO"):"DISABLED",environment:executionEnvironment,liveTradingEnabled}
      });
    }
    if (method === "GET" && url.pathname === "/api/config") {
      await hydrateSettings();
      return sendJson(res,200,{scannerEnabled,autoTradingEnabled,scannerIntervalSeconds:60,riskSettings,persisted:Boolean(supabase),aiProviderId:config.aiProviderId,aiModelId:config.aiModelId,environment:executionEnvironment,liveTradingEnabled});
    }
    if (method === "GET" && url.pathname === "/api/ai/providers") {
      await hydrateSettings();
      let persisted=false;
      if (supabase) { try { await supabase.readCurrent(); persisted=true; } catch {} }
      const configured=Boolean(env.AI_BASE_URL && allowedAIBaseUrl(env.AI_BASE_URL) && typeof env.AI_API_KEY==="string" && env.AI_API_KEY.trim());
      return sendJson(res,200,{configured,providerId:env.AI_PROVIDER_ID||"openai-compatible",providerLabel:env.AI_PROVIDER_LABEL||env.AI_PROVIDER_ID||"OpenAI-compatible",persisted});
    }
    if (method === "POST" && url.pathname === "/api/ai/config") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (typeof body.providerId!=="string" || typeof body.modelId!=="string") return sendJson(res,400,{error:"INVALID_AI_CONFIG",message:"اكتب معرّف المزود ومعرّف النموذج."});
      const requestedProvider=body.providerId.trim(), requestedModel=body.modelId.trim();
      const allowedModels=(env.AI_ALLOWED_MODELS||"").split(",").map(value=>value.trim()).filter(Boolean);
      if (requestedProvider!==(env.AI_PROVIDER_ID||"openai-compatible") ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(requestedModel) ||
          (allowedModels.length>0 && !allowedModels.includes(requestedModel))) {
        return sendJson(res,400,{error:"AI_CONFIG_NOT_ALLOWED",message:"معرّف المزود أو النموذج لا يطابق إعدادات Environment على الخادم."});
      }
      const nextProvider=buildConfiguredAI(requestedProvider,requestedModel);
      if (!nextProvider) return sendJson(res,409,{error:"AI_ENV_OR_MODEL_INVALID",message:"تحقق من AI_PROVIDER_ID وAI_BASE_URL وAI_API_KEY في Environment."});
      let persisted=false;
      if (supabase) {
        try {
          const current=await supabase.readCurrent();
          const expectedVersion=typeof current._version==="number"?current._version:0;
          const settings=Object.fromEntries(Object.entries(current).filter(([key])=>key!=="_version"));
          const saved=await supabase.writeVersioned({...settings,aiProviderId:body.providerId,aiModelId:body.modelId},expectedVersion);
          if (!saved.ok) return sendJson(res,saved.errorCode==="VERSION_CONFLICT"?409:503,{error:saved.errorCode,message:"تعذر حفظ اختيار مزود AI بشكل دائم."});
          persisted=true;
          settingsHydrated=true;
        } catch { return sendJson(res,503,{error:"PERSISTENCE_FAILED",message:"قاعدة البيانات غير متاحة؛ لم يتم تغيير مزود AI."}); }
      }
      config.aiProviderId=body.providerId;
      config.aiModelId=body.modelId;
      aiProvider=nextProvider;
      aiConfigured=true;
      aiProbePassed=false;
      autoTradingEnabled=false;
      return sendJson(res,200,{ok:true,providerId:config.aiProviderId,modelId:config.aiModelId,persisted,message:persisted?"تم حفظ اختيار AI دائمًا.":"تم تغيير AI لهذه الجلسة فقط؛ لا يوجد تخزين دائم."});
    }
    if (method === "POST" && url.pathname === "/api/ai/test") {
      await hydrateSettings();
      if (!aiConfigured || !aiProvider) {
        aiProbePassed=false;
        return sendJson(res,409,{ok:false,error:"AI_NOT_CONFIGURED",message:"احفظ اختيار AI أولًا وتأكد من وجود AI_BASE_URL وAI_API_KEY واسم النموذج المسموح على الخادم."});
      }
      try {
        const assessment=await aiProvider.assess({symbol:"XAUUSD",evidence:[],now:new Date().toISOString(),marketContext:{recentClosedM1:[]}});
        if (assessment.outcome!=="WAIT" && assessment.outcome!=="REJECT") {
          aiProbePassed=false;
          return sendJson(res,502,{ok:false,error:"AI_TEST_UNSAFE_RESPONSE",message:"وصل الرد من AI لكنه أعاد اتجاه تداول دون أدلة. فشل اختبار السلامة؛ لم يتم إرسال أي أمر."});
        }
        aiProbePassed=true;
        return sendJson(res,200,{ok:true,state:"CONNECTED",providerId:assessment.providerId,modelId:assessment.modelId,outcome:assessment.outcome,message:"نجح اختبار الاتصال والرد المنظم من AI. الاختبار لا يستخدم بيانات سوق ولا يرسل أوامر تداول."});
      } catch(error) {
        aiProbePassed=false;
        const code=error && typeof error.code==="string"?error.code:"AI_PROVIDER_UNAVAILABLE";
        return sendJson(res,502,{ok:false,error:code,message:"فشل اتصال AI أو كان الرد غير صالح. راجع عنوان API ومفتاحه وModel ID في إعدادات الخادم."});
      }
    }
    if (method === "POST" && url.pathname === "/api/backtest") {
      let body;
      try { body=await readJson(req,8192); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      const useAI=body.useAI===true;
      let testProvider=null;
      const requestedProvider=typeof body.providerId==="string"?body.providerId.trim():"";
      const requestedModel=typeof body.modelId==="string"?body.modelId.trim():"";
      if (useAI) {
        const allowedModels=(env.AI_ALLOWED_MODELS||"").split(",").map(value=>value.trim()).filter(Boolean);
        if (!requestedProvider || !requestedModel || requestedProvider!==(env.AI_PROVIDER_ID||"openai-compatible") ||
            !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(requestedModel) ||
            (allowedModels.length>0 && !allowedModels.includes(requestedModel))) {
          return sendJson(res,400,{error:"AI_MODEL_NOT_ALLOWLISTED",message:"معرّف المزود أو النموذج غير مسموح وفق إعدادات Environment على الخادم."});
        }
        testProvider=buildConfiguredAI(requestedProvider,requestedModel);
        if (!testProvider) return sendJson(res,409,{error:"AI_ENV_OR_MODEL_INVALID",message:"تحقق من متغيرات AI في Environment. لم يبدأ الاختبار."});
      }
      const health=bridge ? await bridge.health() : null;
      if (!health?.ok || health.value.state!=="CONNECTED" || health.value.environment!=="DEMO") {
        return sendJson(res,409,{error:"MT5_DEMO_NOT_READY",message:"اتصل بجسر MT5 على حساب Demo قبل الاختبار التاريخي."});
      }
      let spreadPrice=body.spreadPrice;
      let spreadSource="USER_INPUT";
      if (spreadPrice===null || spreadPrice===undefined || spreadPrice==="") {
        const quote=await bridge.quote();
        if (!quote.ok || !Number.isFinite(quote.value.ask) || !Number.isFinite(quote.value.bid) || quote.value.ask<quote.value.bid) {
          return sendJson(res,503,{error:"MT5_SPREAD_UNAVAILABLE",message:"تعذر قراءة السبريد الحالي من MT5. أدخل السبريد يدويًا وحاول مجددًا."});
        }
        spreadPrice=quote.value.ask-quote.value.bid;
        spreadSource="CURRENT_MT5_QUOTE";
      }
      if (backtestInFlight) return sendJson(res,409,{error:"BACKTEST_ALREADY_RUNNING",message:"يوجد اختبار تاريخي قيد التنفيذ؛ انتظر حتى ينتهي."});
      backtestInFlight=true;
      try {
        const result=await runHistoricalBacktest({
          bridge,aiProvider:testProvider,aiProviderId:body.providerId.trim(),aiModelId:body.modelId.trim(),
          request:{barsCount:body.barsCount,lots:body.lots,spreadPrice,spreadSource,commissionPerLot:body.commissionPerLot,maxAiCalls:body.maxAiCalls,useAI,minimumRiskRewardRatio:riskSettings?.minimumRiskRewardRatio},
          normalizeClosedCandles,analyzeClosedMarket,coordinateTechnicalAndAI
        });
        return sendJson(res,200,result);
      } catch(error) {
        return sendJson(res,error.status??503,{error:error.code??"BACKTEST_FAILED",message:error.message??"فشل الاختبار التاريخي."});
      } finally { backtestInFlight=false; }
    }
    if (method === "POST" && url.pathname === "/api/config/risk") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      const validation = validateRiskSettings(body);
      if (validation) return sendJson(res,400,{error:validation,message:"إعدادات المخاطرة غير صالحة."});
      if (supabase) {
        try {
          const current = await supabase.readCurrent();
          const expectedVersion = typeof current._version === "number" ? current._version : 0;
          const settings = Object.fromEntries(Object.entries(current).filter(([key])=>key!=="_version"));
          const saved = await supabase.writeVersioned({...settings,riskSettings:body},expectedVersion);
          if (!saved.ok) return sendJson(res,503,{error:"PERSISTENCE_FAILED",message:"تعذر حفظ الإعدادات الدائمة؛ لم يتم تأكيد الحفظ."});
          riskSettings = Object.freeze({...body});
          return sendJson(res,200,{ok:true,persisted:true,version:saved.value.version});
        } catch { return sendJson(res,503,{error:"PERSISTENCE_FAILED",message:"قاعدة البيانات غير متاحة؛ لم يتم تأكيد الحفظ."}); }
      }
      riskSettings = Object.freeze({...body});
      return sendJson(res,200,{ok:true,persisted:false,message:"تم التحقق. التخزين مؤقت داخل عملية الخادم."});
    }
    if (method === "GET" && url.pathname === "/api/scanner/latest") {
      return sendJson(res,200,{scan:latestScanView});
    }
    if (method === "POST" && url.pathname === "/api/scan") {
      const result=await runAndStoreScan("MANUAL");
      return sendJson(res,result.status,result.body);
    }
    if (method === "POST" && url.pathname === "/api/scanner/enabled") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (typeof body.enabled !== "boolean") return sendJson(res,400,{error:"INVALID_VALUE",message:"قيمة تشغيل السكانر غير صالحة."});
      if (!body.enabled) {
        scannerEnabled=false;
        autoTradingEnabled=false;
        if (scannerTimer) clearInterval(scannerTimer);
        scannerTimer=null;
        nextScheduledScanAt=null;
        return sendJson(res,200,{ok:true,enabled:false});
      }
      if (!aiProvider) return sendJson(res,409,{error:"AI_NOT_CONFIGURED",message:"اضبط مزود AI قبل تفعيل السكانر؛ اتصال MT5 غير مطلوب للتحليل والإشارات."});
      scannerEnabled=true;
      if (scannerTimer) clearInterval(scannerTimer);
      nextScheduledScanAt=Date.now()+60000;
      const scheduleAtNextClosedM1=()=>{ if (!scannerEnabled) return; const nowMs=Date.now(); const delay=60000-(nowMs%60000)+2000; nextScheduledScanAt=nowMs+delay; scannerTimer=setTimeout(async()=>{ if (!scannerEnabled) return; try { if (await enforceScheduledDailyRiskGuard()) await runAndStoreScan("SCHEDULED"); } finally { scheduleAtNextClosedM1(); } },delay); scannerTimer.unref?.(); };
      void (async()=>{ if (await enforceScheduledDailyRiskGuard()) await runAndStoreScan("SCHEDULED"); })().finally(()=>scheduleAtNextClosedM1());
      return sendJson(res,200,{ok:true,enabled:true,intervalSeconds:60});
    }
    if (method === "POST" && url.pathname === "/api/trading/environment") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (body.environment !== "DEMO" && body.environment !== "LIVE") return sendJson(res,400,{error:"INVALID_ENVIRONMENT"});
      if (autoTradingEnabled || scannerEnabled) return sendJson(res,409,{error:"STOP_EXECUTION_FIRST",message:"أوقف السكانر والتنفيذ الآلي قبل تغيير بيئة التنفيذ."});
      if (body.environment === "LIVE") {
        if (!liveTradingEnabled || body.confirmation !== "I_UNDERSTAND_LIVE_TRADING_RISK") return sendJson(res,403,{error:"LIVE_NOT_AUTHORIZED",message:"التداول الحقيقي مغلق. يلزم تفعيل LIVE_TRADING_ENABLED ومفتاح التأكيد على الخادم، ثم تأكيد المخاطر صراحة."});
      }
      if (!bridge) return sendJson(res,409,{error:"MT5_BRIDGE_NOT_CONFIGURED",message:"اضبط جسر MT5 على جهاز MT5 واتصال HTTPS آمنًا من Render."});
      const switched=await bridge.setEnvironment(body.environment,body.confirmation);
      if (!switched.ok) return sendJson(res,switched.status===403?403:409,{error:"MT5_ENVIRONMENT_SWITCH_FAILED",message:"رفض جسر MT5 تغيير البيئة. تحقق من الحساب المتصل وإعدادات LIVE على جهاز MT5."});
      const health=await bridge.health();
      if (!health.ok || health.value.state!=="CONNECTED" || health.value.environment!==body.environment || health.value.executionReady!==true) {
        await bridge.setEnvironment("DEMO");
        return sendJson(res,409,{error:"MT5_ENVIRONMENT_MISMATCH",message:"حساب MT5 المتصل لا يطابق البيئة المطلوبة أو غير جاهز؛ أُعيد الجسر إلى Demo."});
      }
      executionEnvironment=body.environment;
      autoTradingEnabled=false;
      return sendJson(res,200,{ok:true,environment:executionEnvironment,liveTradingEnabled});
    }
    if (method === "POST" && url.pathname === "/api/trading/auto") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (typeof body.enabled!=="boolean") return sendJson(res,400,{error:"INVALID_VALUE"});
      if (!body.enabled) { autoTradingEnabled=false; return sendJson(res,200,{ok:true,enabled:false,environment:executionEnvironment,liveTradingEnabled}); }
      await hydrateSettings();
      if (!dailyLossGuardConfig({},riskSettings)) return sendJson(res,409,{error:"DAILY_RISK_LIMITS_NOT_CONFIGURED",message:"احفظ حد الخسارة اليومية وعدد الخسائر المتتالية من قسم المخاطر قبل تفعيل التنفيذ الآلي."});
      if (!env.FINNHUB_API_KEY?.trim()) return sendJson(res,409,{error:"NEWS_CALENDAR_NOT_CONFIGURED",message:"اضبط FINNHUB_API_KEY لتفعيل فلتر الأخبار الآلي قبل التنفيذ الآلي."});
      const calendarStatus=await economicCalendarBlock(env);
      if (calendarStatus) return sendJson(res,calendarStatus==="HIGH_IMPACT_NEWS_BLACKOUT"?409:503,{error:calendarStatus,message:calendarStatus==="HIGH_IMPACT_NEWS_BLACKOUT"?"يوجد خبر أمريكي عالي التأثير ضمن نافذة الحظر؛ لا يمكن تسليح التنفيذ الآن.":"تعذر التحقق من تقويم الأخبار الاقتصادي؛ التنفيذ الآلي مغلق."});
      if (!scannerEnabled || !bridge || !aiProvider || !supabase || !riskSettings) return sendJson(res,409,{error:"EXECUTION_PREREQUISITES_MISSING",message:"يلزم تفعيل السكانر وضبط MT5 وAI والمخاطرة وSupabase قبل التنفيذ الآلي."});
      const health=await bridge.health();
      if (!health.ok || health.value.state!=="CONNECTED" || health.value.environment!==executionEnvironment || !health.value.accountLogin || health.value.executionReady!==true) return sendJson(res,409,{error:"MT5_ACCOUNT_NOT_CONFIRMED",message:"يلزم حساب MT5 مطابق لبيئة التنفيذ ومن نوع Hedging مع تأكيد الجاهزية؛ التنفيذ الآلي ما زال متوقفًا."});
      const positions=await bridge.positions();
      if (!positions.ok || positions.value.positions.some(position=>!position.ownedByBot)) return sendJson(res,409,{error:"UNOWNED_XAUUSD_POSITION_CONFLICT",message:"يوجد مركز XAUUSD لا يمكن تأكيد ملكيته للبوت؛ أغلقه أو افحصه يدويًا قبل تفعيل التنفيذ الآلي."});
      try { await supabase.readCurrent(); } catch { return sendJson(res,503,{error:"PERSISTENCE_UNAVAILABLE",message:"قاعدة البيانات غير متاحة؛ التنفيذ الآلي مرفوض."}); }
      try {
        const probe=await aiProvider.assess({symbol:"XAUUSD",evidence:[],now:new Date().toISOString()});
        if (probe.outcome==="BUY" || probe.outcome==="SELL") return sendJson(res,409,{error:"AI_PROBE_UNSAFE",message:"مزود AI أعاد اتجاه تداول دون أدلة؛ التنفيذ الآلي مرفوض."});
        aiProbePassed=true;
      } catch { return sendJson(res,503,{error:"AI_PROVIDER_UNAVAILABLE",message:"اختبار اتصال AI فشل؛ التنفيذ الآلي مرفوض."}); }
      const riskStatus=await dailyRiskGuardStatus();
      if (!riskStatus.ok) return sendJson(res,409,{error:riskStatus.code,message:"مراقب المخاطر يمنع تفعيل التنفيذ الآلي حتى تُحل المشكلة أو يبدأ يوم تداول جديد.",risk:riskStatus});
      autoTradingEnabled=true;
      return sendJson(res,200,{ok:true,enabled:true,environment:executionEnvironment,liveTradingEnabled});
    }
    if (method === "GET" && url.pathname === "/api/scanner/log") return sendJson(res,200,{runs:scannerRuns});
    if (method === "GET" && url.pathname === "/api/positions") {
      if (!bridge) return sendJson(res,503,{error:"MT5_NOT_CONFIGURED",positions:[]});
      const health=await bridge.health();
      if (!health.ok || health.value.state!=="CONNECTED" || health.value.environment!==executionEnvironment) return sendJson(res,503,{error:"MT5_ACCOUNT_NOT_READY",positions:[]});
      if (health.value.executionReady!==true) return sendJson(res,409,{error:"HEDGING_ACCOUNT_REQUIRED",message:"عرض وإدارة صفقات البوت يتطلب حساب MT5 Demo من نوع Hedging.",positions:[]});
      const result=await bridge.positions();
      if (!result.ok) return sendJson(res,503,{error:result.message,positions:[]});
      return sendJson(res,200,{positions:result.value.positions.filter(position=>position.ownedByBot).map(({ownedByBot,...position})=>position),ownershipConflict:result.value.positions.some(position=>!position.ownedByBot),environment:executionEnvironment});
    }
    if (method === "POST" && url.pathname === "/api/positions/modify") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (!bridge || !Number.isInteger(body.ticket) || (body.stopLoss!==undefined && (!Number.isFinite(body.stopLoss)||body.stopLoss<0)) || (body.takeProfit!==undefined && (!Number.isFinite(body.takeProfit)||body.takeProfit<0))) return sendJson(res,400,{error:"INVALID_POSITION_UPDATE",message:"بيانات تعديل الوقف أو الهدف غير صالحة."});
      const result=await bridge.modifyPosition({ticket:body.ticket,...(body.stopLoss!==undefined?{stopLoss:body.stopLoss}:{}),...(body.takeProfit!==undefined?{takeProfit:body.takeProfit}:{})});
      if (!result.ok) return sendJson(res,result.status===202?202:503,{error:result.errorCode,message:result.message});
      let persisted=false;
      if (result.value.state==="CONFIRMED" && supabase && bridge) {
        try {
          const health=await bridge.health();
          if (health.ok && health.value.accountLogin) {
            const open=await supabase.listOpenPositions(String(health.value.accountLogin));
            const row=open.find(item=>item.broker_position_id===String(body.ticket));
            if (row && typeof row.id==="string") {
              const saved=await supabase.updateRecord("positions",row.id,{stop_loss:body.stopLoss??row.stop_loss,take_profit:body.takeProfit??row.take_profit,updated_at:new Date().toISOString()});
              persisted=saved.ok && saved.value.updated;
              if (persisted) await supabase.insertRecord("trade_events",{id:randomUUID(),position_id:row.id,execution_intent_id:null,event_type:"POSITION_PROTECTION_MODIFIED",payload:{ticket:body.ticket,stopLoss:body.stopLoss??row.stop_loss,takeProfit:body.takeProfit??row.take_profit},occurred_at:new Date().toISOString()});
            }
          }
        } catch {}
        await queueNotificationToEnabled("تم تأكيد تعديل حماية صفقة XAUUSD رقم "+body.ticket+".","POSITION_PROTECTION_MODIFIED","position-modified:"+body.ticket+":"+(body.stopLoss??"keep")+":"+(body.takeProfit??"keep"));
      }
      return sendJson(res,result.value.state==="CONFIRMED"?200:result.value.state==="RECONCILIATION_REQUIRED"?202:422,{...result.value,persisted});
    }
    if (method === "POST" && url.pathname === "/api/positions/close") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (!bridge || !Number.isInteger(body.ticket)) return sendJson(res,400,{error:"INVALID_TICKET",message:"رقم الصفقة غير صالح."});
      const result=await bridge.closePosition({ticket:body.ticket,idempotencyKey:"manual-close:"+body.ticket});
      if (!result.ok) return sendJson(res,result.status===202?202:503,{error:result.errorCode,message:result.message});
      let persisted=false;
      if (result.value.state==="CONFIRMED" && supabase && bridge) {
        try {
          const health=await bridge.health();
          if (health.ok && health.value.accountLogin) {
            const open=await supabase.listOpenPositions(String(health.value.accountLogin));
            const row=open.find(item=>item.broker_position_id===String(body.ticket));
            if (row && typeof row.id==="string") {
              const saved=await supabase.updateRecord("positions",row.id,{status:"CLOSED",closed_at:new Date().toISOString(),updated_at:new Date().toISOString()});
              persisted=saved.ok && saved.value.updated;
              if (persisted) await supabase.insertRecord("trade_events",{id:randomUUID(),position_id:row.id,execution_intent_id:null,event_type:"POSITION_CLOSED_MANUALLY",payload:{ticket:body.ticket,brokerOrderId:result.value.brokerOrderId},occurred_at:new Date().toISOString()});
            }
          }
        } catch {}
        await queueNotificationToEnabled("تم تأكيد إغلاق صفقة XAUUSD رقم "+body.ticket+" على حساب Demo.","POSITION_CLOSED","position-closed:"+body.ticket);
      }
      return sendJson(res,result.value.state==="CONFIRMED"?200:result.value.state==="RECONCILIATION_REQUIRED"?202:422,{...result.value,persisted});
    }
    if (method === "GET" && url.pathname === "/api/telegram/chats") {
      if (supabase) {
        try {
          const chats=await supabase.listTelegramChats();
          return sendJson(res,200,{chats:chats.map(chat=>({chatId:String(chat.chat_id),title:String(chat.display_name??chat.chat_id),type:"unknown",enabled:chat.enabled===true,persisted:true}))});
        } catch { return sendJson(res,503,{error:"CHAT_STORAGE_UNAVAILABLE",message:"تعذر قراءة قائمة محادثات Telegram الدائمة."}); }
      }
      return sendJson(res,200,{chats:telegram.listDiscoveredChats().map(chat=>({...chat,enabled:enabledChats.has(chat.chatId),persisted:false}))});
    }
    if (method === "POST" && url.pathname === "/api/telegram/discover") {
      try {
        const discovered=await telegram.discoverChats();
        if (supabase) {
          for (const chat of discovered) {
            const saved=await supabase.upsertTelegramChat({chatId:chat.chatId,displayName:chat.title,discoveredAt:chat.lastSeenAt});
            if (!saved.ok) return sendJson(res,503,{error:"CHAT_PERSIST_FAILED",message:"تم اكتشاف المحادثات لكن تعذر حفظها بشكل دائم."});
          }
          const chats=await supabase.listTelegramChats();
          return sendJson(res,200,{chats:chats.map(chat=>({chatId:String(chat.chat_id),title:String(chat.display_name??chat.chat_id),type:"unknown",enabled:chat.enabled===true,persisted:true}))});
        }
        return sendJson(res,200,{chats:discovered.map(chat=>({...chat,enabled:enabledChats.has(chat.chatId),persisted:false}))});
      } catch(error) {
        const code=error instanceof TelegramClientError?error.code:"TELEGRAM_ERROR";
        return sendJson(res,503,{error:code,message:error instanceof Error?error.message:"تعذر اكتشاف المحادثات."});
      }
    }
    if (method === "POST" && url.pathname === "/api/telegram/enable") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (typeof body.chatId!=="string" || typeof body.enabled!=="boolean") return sendJson(res,400,{error:"UNKNOWN_CHAT",message:"اكتشف المحادثة أولًا."});
      if (supabase) {
        try {
          const known=(await supabase.listTelegramChats()).some(chat=>chat.chat_id===body.chatId);
          if (!known) return sendJson(res,400,{error:"UNKNOWN_CHAT",message:"اكتشف المحادثة أولًا."});
          const saved=await supabase.setTelegramChatEnabled(body.chatId,body.enabled);
          if (!saved.ok || !saved.value.updated) return sendJson(res,503,{error:"CHAT_PERSIST_FAILED",message:"لم يتم تأكيد حفظ إعداد المحادثة."});
          return sendJson(res,200,{ok:true,enabled:body.enabled,persisted:true});
        } catch { return sendJson(res,503,{error:"CHAT_STORAGE_UNAVAILABLE",message:"تعذر حفظ إعداد المحادثة."}); }
      }
      if (!telegram.listDiscoveredChats().some(chat=>chat.chatId===body.chatId)) return sendJson(res,400,{error:"UNKNOWN_CHAT",message:"اكتشف المحادثة أولًا."});
      if (body.enabled) enabledChats.add(body.chatId); else enabledChats.delete(body.chatId);
      return sendJson(res,200,{ok:true,enabled:enabledChats.has(body.chatId),persisted:false});
    }
    if (method === "POST" && url.pathname === "/api/telegram/test-all") {
      if (!telegram.configured) return sendJson(res,409,{error:"NOT_CONFIGURED",message:"أضف TELEGRAM_BOT_TOKEN إلى Environment على الخادم."});
      let chats=[];
      try {
        if (supabase) chats=(await supabase.listTelegramChats()).map(chat=>({chatId:String(chat.chat_id),title:String(chat.display_name??chat.chat_id)}));
        else chats=telegram.listDiscoveredChats().map(chat=>({chatId:chat.chatId,title:chat.title}));
      } catch {
        return sendJson(res,503,{error:"CHAT_STORAGE_UNAVAILABLE",message:"تعذر قراءة المحادثات المكتشفة."});
      }
      if (!chats.length) return sendJson(res,409,{error:"NO_TELEGRAM_CHATS",message:"لم تُكتشف محادثة بعد. افتح محادثة البوت واضغط Start؛ سيكتشفها النظام تلقائيًا."});
      const results=[];
      for (const chat of chats) {
        const result=await sendWithOutbox(chat.chatId,"اختبار إشعارات Telegram من XAUUSD AI Trading Bot. الاتصال يعمل إذا وصلتك هذه الرسالة.","MANUAL_TEST","manual-test-all:"+chat.chatId+":"+randomUUID());
        results.push({chatId:chat.chatId,title:chat.title,ok:result.ok,errorCode:result.ok?undefined:result.errorCode});
      }
      const sent=results.filter(item=>item.ok).length, failed=results.length-sent;
      return sendJson(res,failed?502:200,{ok:failed===0,sent,failed,results,message:failed===0?"تم إرسال إشعار الاختبار إلى جميع المحادثات المكتشفة.":"تم إرسال بعض الإشعارات فقط؛ راجع حالة كل محادثة."});
    }
    if (method === "POST" && url.pathname === "/api/telegram/test") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (typeof body.chatId!=="string") return sendJson(res,400,{error:"UNKNOWN_CHAT",message:"اكتشف المحادثة أولًا."});
      if (supabase) {
        try { if (!(await supabase.listTelegramChats()).some(chat=>chat.chat_id===body.chatId)) return sendJson(res,400,{error:"UNKNOWN_CHAT",message:"اكتشف المحادثة أولًا."}); }
        catch { return sendJson(res,503,{error:"CHAT_STORAGE_UNAVAILABLE",message:"تعذر قراءة المحادثات."}); }
      } else if (!telegram.listDiscoveredChats().some(chat=>chat.chatId===body.chatId)) {
        return sendJson(res,400,{error:"UNKNOWN_CHAT",message:"اكتشف المحادثة أولًا."});
      }
      const result=await sendWithOutbox(body.chatId,"اختبار اتصال من XAUUSD AI Trading Bot. هذه رسالة اختبار فقط.","MANUAL_TEST","manual-test:"+body.chatId+":"+randomUUID());
      if (!result.ok) return sendJson(res,503,{error:result.errorCode,message:"تعذر إرسال رسالة الاختبار أو حفظ حالتها."});
      return sendJson(res,200,{ok:true,messageId:result.messageId,persisted:result.persisted});
    }
    if (url.pathname.startsWith("/api/")) return sendJson(res,404,{error:"NOT_FOUND",message:"المسار غير موجود."});
    if (method !== "GET" && method !== "HEAD") return sendJson(res,405,{error:"METHOD_NOT_ALLOWED"});
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = resolve(root,"."+filePath);
    if (!target.startsWith(root + sep)) return sendJson(res,404,{error:"NOT_FOUND"});
    try {
      const data = await readFile(target);
      res.writeHead(200,{"content-type":MIME[extname(target)]??"application/octet-stream","cache-control":"no-cache","content-length":data.length});
      if (method==="HEAD") res.end(); else res.end(data);
    } catch { sendJson(res,404,{error:"NOT_FOUND"}); }
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  const server = createAppServer();
  server.listen(port,host,()=>process.stdout.write("XAUUSD dashboard listening on "+host+":"+port+"\n"));
}
