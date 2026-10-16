import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRiskSettings, TelegramBotClient, TelegramClientError, SupabaseRestRepository,
  MT5BridgeClient, normalizeClosedCandles, analyzeClosedMarket,
  OpenAICompatibleAIProvider, coordinateTechnicalAndAI, prepareExecutionIntent
} from "./dist/index.js";

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
function configuredAI(env) {
  if (!env.AI_API_KEY?.trim() || !env.AI_BASE_URL || !env.AI_MODEL_ID?.trim()) return null;
  try {
    const endpoint = new URL(env.AI_BASE_URL);
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") return null;
    return new OpenAICompatibleAIProvider({
      providerId:env.AI_PROVIDER_ID || "openai-compatible", modelId:env.AI_MODEL_ID,
      baseUrl:env.AI_BASE_URL, apiKey:env.AI_API_KEY, timeoutMs:15000, assessmentTtlMs:60000
    });
  } catch { return null; }
}
function validRiskSettings(value) {
  return value && typeof value === "object" && validateRiskSettings(value) === null;
}
export function createAppServer(env = process.env) {
  const telegram = new TelegramBotClient(env.TELEGRAM_BOT_TOKEN);
  const supabase = configuredSupabase(env);
  const bridge = configuredBridge(env);
  const aiProvider = configuredAI(env);
  const enabledChats = new Set();
  let riskSettings = null;
  let scannerRuns = [];
  let scannerEnabled = false;
  let autoTradingEnabled = false;
  let aiProbePassed = false;
  let scannerTimer = null;
  let scanInFlight = false;
  const config = { aiProviderId:env.AI_PROVIDER_ID ?? null, aiModelId:env.AI_MODEL_ID ?? null };
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
    const recipients=[...enabledChats];
    void telegram.sendToDiscoveredChats(message,recipients).catch(()=>undefined);
    return {sent:0,failed:0,reason:"PROCESS_LOCAL_QUEUED"};
  }


  async function hydrateSettings() {
    if (!supabase || riskSettings) return;
    try {
      const current = await supabase.readCurrent();
      if (validRiskSettings(current.riskSettings)) riskSettings = Object.freeze({...current.riskSettings});
    } catch {}
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
      if (!bridge) {
        const entry=record("NOT_READY","MT5_BRIDGE_NOT_CONFIGURED");
        return {status:409,body:{error:"SCANNER_NOT_READY",message:"لم يتم ضبط جسر MT5 مع رمز المصادقة؛ لم يتم توليد إشارة.",run:entry}};
      }
      const health = await bridge.health();
      if (!health.ok || health.value.state !== "CONNECTED" || health.value.environment !== "DEMO") {
        const entry=record("NOT_READY",health.ok?health.value.reason:health.message);
        return {status:503,body:{error:"MT5_NOT_READY",message:"اتصال MT5 التجريبي غير مؤكد؛ تم إيقاف الفحص بأمان.",run:entry}};
      }
      const timeframes = ["M1","M5","M15","H1"];
      const fetched = await Promise.all(timeframes.map(async timeframe => [timeframe,await bridge.candles(timeframe, timeframe==="M1"?120:60)]));
      const normalized = {};
      for (const [timeframe,result] of fetched) {
        if (!result.ok) {
          const entry=record("NO_ANALYSIS","MARKET_DATA_UNAVAILABLE",{timeframe,error:result.message});
          return {status:503,body:{error:"MARKET_DATA_UNAVAILABLE",message:"تعذر جلب بيانات الشموع المغلقة؛ لم يتم إنشاء إشارة.",run:entry}};
        }
        const bars = normalizeClosedCandles(result.value.candles,timeframe,timeframe==="M1"?35:1);
        if (!bars.ok) {
          const entry=record("NO_ANALYSIS",bars.error,{timeframe});
          return {status:409,body:{error:bars.error,message:"بيانات السوق غير صالحة للتحليل.",run:entry}};
        }
        normalized[timeframe]=bars.value;
      }
      const now = new Date().toISOString();
      const analysis = analyzeClosedMarket({symbol:"XAUUSD",candles:normalized,now,maxM1AgeMs:120000,minimumM1Bars:35});
      if (analysis.status === "NO_ANALYSIS") {
        const entry=record("NO_ANALYSIS",analysis.reason,{latestClosedBarTime:analysis.latestClosedBarTime});
        return {status:409,body:{error:analysis.reason,message:"البيانات غير كافية أو قديمة؛ لا توجد إشارة.",analysis,run:entry}};
      }
      if (analysis.status === "WAIT") {
        const entry=record("WAIT",analysis.reason,{metrics:analysis.metrics});
        return {status:200,body:{status:"WAIT",message:"اكتمل التحليل الفني دون فرصة مطابقة؛ لم يتم إصدار إشارة.",analysis,run:entry}};
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
        return {status:503,body:{error:"AI_NOT_CONFIGURED",message:"تم رصد مرشح فني، لكن AI غير مهيأ. لا يتم اعتماد اتجاه أو إرسال أمر.",analysis:{...analysis,evidence:analysis.evidence.map(({entryPrice,stopLoss,takeProfit,direction,strategyId})=>({entryPrice,stopLoss,takeProfit,direction,strategyId}))},run:entry}};
      }
      let assessment;
      try {
        assessment = await aiProvider.assess({symbol:"XAUUSD",evidence:analysis.evidence,now});
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
          "TRADE_DECISION","decision:"+candidateId+":"+decision.outcome
        );
      }
      let execution = "NOT_SUBMITTED";
      let executionDetail = "التنفيذ الآلي غير مفعّل.";
      if ((decision.outcome === "BUY" || decision.outcome === "SELL") && autoTradingEnabled) {
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
        const prepared = prepareExecutionIntent({
          id:randomUUID(),idempotencyKey:candidateKey+":DEMO",opportunityId:candidateId,decisionId,
          environment:"DEMO",settings:riskSettings,
          trade:{direction:decision.direction,entryPrice:decision.direction==="BUY"?liveQuote.value.ask:liveQuote.value.bid,stopLoss:evidence.stopLoss,takeProfit:evidence.takeProfit,minimumRiskRewardRatio:riskSettings.minimumRiskRewardRatio},
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
        const submitted = await bridge.submitDemoOrder({intent:storedIntent.value.intent});
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
              request_payload:{symbol:"XAUUSD",direction:decision.direction,volume:prepared.intent.volume,stopLoss:evidence.stopLoss,takeProfit:evidence.takeProfit},
              response_payload:submitted.value,created_at:new Date().toISOString(),updated_at:new Date().toISOString()
            });
            orderPersisted = order.ok;
          }
          const auditEvent = await supabase.insertRecord("trade_events",{id:randomUUID(),execution_intent_id:prepared.intent.id,event_type:"DEMO_ORDER_CONFIRMED",payload:{brokerOrderId:submitted.value.brokerOrderId,orderPersisted},occurred_at:new Date().toISOString()});
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
          reasonCodes:decision.reasonCodes,analysis,assessment,decision,notification,execution,executionDetail,run:entry
        }
      };
    } catch {
      await queueNotificationToEnabled("تنبيه النظام: فشلت دورة فحص XAUUSD. راجع سجل النظام قبل إعادة المحاولة.","SYSTEM_ALERT","scan-failure:"+runId);
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

  const outboxTimer = supabase && telegram.configured ? setInterval(()=>{ void drainOutbox(); },15000) : null;
  outboxTimer?.unref?.();
  const server = createServer(async (req,res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/health") {
      let databaseState = "NOT_CONFIGURED";
      if (supabase) { try { await supabase.readCurrent(); databaseState = "CONNECTED"; } catch { databaseState = "DISCONNECTED"; } }
      let bridgeHealth = null;
      if (bridge) { const result=await bridge.health(); if (result.ok) bridgeHealth=result.value; }
      const marketState = !bridge ? "NOT_CONFIGURED" : bridgeHealth?.state === "CONNECTED" ? "CONNECTED" : bridgeHealth?.state === "BLOCKED" ? "DISCONNECTED" : "NOT_READY";
      const aiConfigured = Boolean(aiProvider);
      return sendJson(res,200,{
        marketData:{state:marketState,label:marketState==="CONNECTED"?"MT5 Demo متصل":"MT5 غير متصل",reason:marketState==="CONNECTED"?"تم تأكيد حساب Demo.":bridgeHealth?.reason??"لم يتم ضبط جسر MT5؛ لا توجد بيانات سوق فعلية."},
        ai:{state:!aiConfigured?"NOT_CONFIGURED":aiProbePassed?"CONNECTED":"CONFIGURED_NOT_TESTED",label:!aiConfigured?"لم يتم الاتصال":aiProbePassed?"AI متصل":"إعدادات موجودة · الاتصال يحتاج اختبارًا"},
        database:{state:databaseState,label:databaseState==="CONNECTED"?"Supabase متصل":"Supabase غير متصل"},
        telegram:{state:telegram.configured?"CONFIGURED":"NOT_CONFIGURED",label:telegram.configured?"البوت مهيأ":"التنبيهات غير جاهزة"},
        scanner:{state:scannerEnabled?"CONNECTED":"NOT_READY",label:scannerEnabled?"السكانر مفعّل":"السكانر غير جاهز",reason:scannerEnabled?"يفحص كل 60 ثانية؛ التنفيذ يعتمد على إعدادات Demo والمخاطر.":"يتطلب اتصال MT5 Demo وتهيئة AI."},
        execution:{state:autoTradingEnabled?"ARMED_DEMO":"DISABLED",liveTradingEnabled:false}
      });
    }
    if (method === "GET" && url.pathname === "/api/config") {
      await hydrateSettings();
      return sendJson(res,200,{scannerEnabled,autoTradingEnabled,scannerIntervalSeconds:60,riskSettings,persisted:Boolean(supabase),aiProviderId:config.aiProviderId,aiModelId:config.aiModelId,environment:"DEMO",liveTradingEnabled:false});
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
    if (method === "POST" && url.pathname === "/api/scan") {
      const result=await performScan("MANUAL");
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
        return sendJson(res,200,{ok:true,enabled:false});
      }
      if (!bridge || !aiProvider) return sendJson(res,409,{error:"DEPENDENCIES_NOT_CONFIGURED",message:"يلزم ضبط جسر MT5 ومزود AI قبل تفعيل السكانر."});
      const health=await bridge.health();
      if (!health.ok || health.value.state!=="CONNECTED" || health.value.environment!=="DEMO") return sendJson(res,409,{error:"MT5_NOT_READY",message:"لا يمكن تفعيل السكانر دون حساب MT5 Demo متصل."});
      scannerEnabled=true;
      if (scannerTimer) clearInterval(scannerTimer);
      scannerTimer=setInterval(()=>{ void performScan("SCHEDULED"); },60000);
      scannerTimer.unref?.();
      void performScan("SCHEDULED");
      return sendJson(res,200,{ok:true,enabled:true,intervalSeconds:60});
    }
    if (method === "POST" && url.pathname === "/api/trading/auto") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (typeof body.enabled!=="boolean") return sendJson(res,400,{error:"INVALID_VALUE"});
      if (!body.enabled) { autoTradingEnabled=false; return sendJson(res,200,{ok:true,enabled:false,environment:"DEMO",liveTradingEnabled:false}); }
      await hydrateSettings();
      if (!scannerEnabled || !bridge || !aiProvider || !supabase || !riskSettings) return sendJson(res,409,{error:"EXECUTION_PREREQUISITES_MISSING",message:"يلزم تفعيل السكانر وضبط MT5 Demo وAI والمخاطرة وSupabase قبل التنفيذ الآلي."});
      const health=await bridge.health();
      if (!health.ok || health.value.state!=="CONNECTED" || health.value.environment!=="DEMO" || !health.value.accountLogin) return sendJson(res,409,{error:"MT5_DEMO_NOT_CONFIRMED",message:"لم يتم تأكيد حساب Demo؛ التنفيذ الآلي ما زال متوقفًا."});
      try { await supabase.readCurrent(); } catch { return sendJson(res,503,{error:"PERSISTENCE_UNAVAILABLE",message:"قاعدة البيانات غير متاحة؛ التنفيذ الآلي مرفوض."}); }
      try {
        const probe=await aiProvider.assess({symbol:"XAUUSD",evidence:[],now:new Date().toISOString()});
        if (probe.outcome==="BUY" || probe.outcome==="SELL") return sendJson(res,409,{error:"AI_PROBE_UNSAFE",message:"مزود AI أعاد اتجاه تداول دون أدلة؛ التنفيذ الآلي مرفوض."});
        aiProbePassed=true;
      } catch { return sendJson(res,503,{error:"AI_PROVIDER_UNAVAILABLE",message:"اختبار اتصال AI فشل؛ التنفيذ الآلي مرفوض."}); }
      autoTradingEnabled=true;
      return sendJson(res,200,{ok:true,enabled:true,environment:"DEMO",liveTradingEnabled:false});
    }
    if (method === "GET" && url.pathname === "/api/scanner/log") return sendJson(res,200,{runs:scannerRuns});
    if (method === "GET" && url.pathname === "/api/positions") {
      if (!bridge) return sendJson(res,503,{error:"MT5_NOT_CONFIGURED",positions:[]});
      const health=await bridge.health();
      if (!health.ok || health.value.state!=="CONNECTED" || health.value.environment!=="DEMO") return sendJson(res,503,{error:"MT5_DEMO_NOT_READY",positions:[]});
      const result=await bridge.positions();
      if (!result.ok) return sendJson(res,503,{error:result.message,positions:[]});
      return sendJson(res,200,{positions:result.value.positions,environment:"DEMO"});
    }
    if (method === "POST" && url.pathname === "/api/positions/modify") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (!bridge || !Number.isInteger(body.ticket) || (body.stopLoss!==undefined && (!Number.isFinite(body.stopLoss)||body.stopLoss<0)) || (body.takeProfit!==undefined && (!Number.isFinite(body.takeProfit)||body.takeProfit<0))) return sendJson(res,400,{error:"INVALID_POSITION_UPDATE",message:"بيانات تعديل الوقف أو الهدف غير صالحة."});
      const result=await bridge.modifyPosition({ticket:body.ticket,...(body.stopLoss!==undefined?{stopLoss:body.stopLoss}:{}),...(body.takeProfit!==undefined?{takeProfit:body.takeProfit}:{})});
      if (!result.ok) return sendJson(res,result.status===202?202:503,{error:result.errorCode,message:result.message});
      return sendJson(res,result.value.state==="CONFIRMED"?200:result.value.state==="RECONCILIATION_REQUIRED"?202:422,result.value);
    }
    if (method === "POST" && url.pathname === "/api/positions/close") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (!bridge || !Number.isInteger(body.ticket)) return sendJson(res,400,{error:"INVALID_TICKET",message:"رقم الصفقة غير صالح."});
      const result=await bridge.closePosition({ticket:body.ticket,idempotencyKey:"manual-close:"+body.ticket});
      if (!result.ok) return sendJson(res,result.status===202?202:503,{error:result.errorCode,message:result.message});
      return sendJson(res,result.value.state==="CONFIRMED"?200:result.value.state==="RECONCILIATION_REQUIRED"?202:422,result.value);
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
  if (!["127.0.0.1","localhost","::1"].includes(host)) {
    process.stderr.write("Remote dashboard binding is disabled. Keep the dashboard on loopback.\n");
    process.exitCode = 1;
  } else {
    const port = Number(process.env.PORT ?? 3000);
    const server = createAppServer();
    server.listen(port,host,()=>process.stdout.write("XAUUSD dashboard listening on "+host+":"+port+"\n"));
  }
}
