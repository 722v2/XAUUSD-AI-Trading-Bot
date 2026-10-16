import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRiskSettings, TelegramBotClient, TelegramClientError, SupabaseRestRepository,
  MT5BridgeClient, normalizeClosedCandles, analyzeClosedMarket,
  OpenAICompatibleAIProvider, coordinateTechnicalAndAI
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
  if (!env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL_ID) return null;
  try {
    return new OpenAICompatibleAIProvider({
      providerId:env.AI_PROVIDER_ID || "openai-compatible", modelId:env.AI_MODEL_ID,
      baseUrl:env.AI_BASE_URL, apiKey:env.AI_API_KEY, timeoutMs:15000, assessmentTtlMs:60000
    });
  } catch { return null; }
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
  let scannerTimer = null;
  let scanInFlight = false;
  const config = { aiProviderId:env.AI_PROVIDER_ID ?? null, aiModelId:env.AI_MODEL_ID ?? null };

  async function performScan(triggerType = "MANUAL") {
    if (scanInFlight) return { status:409, body:{error:"SCAN_ALREADY_RUNNING",message:"هناك دورة فحص قيد التنفيذ."} };
    scanInFlight = true;
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const record = (status, reason, extra = {}) => {
      const entry = {id:runId,at:startedAt,triggerType,status,reason,...extra};
      scannerRuns = [entry,...scannerRuns].slice(0,50);
      return entry;
    };
    try {
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
      if (!aiProvider) {
        const entry=record("AI_NOT_CONFIGURED","TECHNICAL_CANDIDATE_ONLY",{metrics:analysis.metrics});
        return {status:503,body:{error:"AI_NOT_CONFIGURED",message:"تم رصد مرشح فني، لكن AI غير مهيأ. لا يتم اعتماد اتجاه أو إرسال أمر.",analysis:{...analysis,evidence:analysis.evidence.map(({entryPrice,stopLoss,takeProfit,direction,strategyId})=>({entryPrice,stopLoss,takeProfit,direction,strategyId}))},run:entry}};
      }
      const assessment = await aiProvider.assess({symbol:"XAUUSD",evidence:analysis.evidence,now});
      const decision = coordinateTechnicalAndAI(analysis.evidence,assessment);
      const entry=record(decision.outcome,"AI_ASSESSMENT_COMPLETED",{reasonCodes:decision.reasonCodes,technicalStatus:analysis.status,aiOutcome:assessment.outcome});
      return {
        status:200,
        body:{
          status:decision.outcome,
          message:decision.outcome==="BUY"||decision.outcome==="SELL"
            ? "قرار تحليلي متوافق؛ لم يتم إرسال أمر تداول."
            : "لم يتم اعتماد دخول بسبب الانتظار أو التعارض أو الرفض.",
          reasonCodes:decision.reasonCodes,analysis,assessment,decision,execution:"NOT_SUBMITTED",run:entry
        }
      };
    } catch (error) {
      const entry=record("FAILED","UNEXPECTED_SCAN_FAILURE");
      return {status:503,body:{error:"SCAN_FAILED",message:"فشل الفحص؛ تم تسجيله دون إنشاء إشارة.",run:entry}};
    } finally {
      scanInFlight = false;
    }
  }

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
        ai:{state:aiConfigured?"CONFIGURED_NOT_TESTED":"NOT_CONFIGURED",label:aiConfigured?"إعدادات موجودة · الاتصال يحتاج اختبارًا":"لم يتم الاتصال"},
        database:{state:databaseState,label:databaseState==="CONNECTED"?"Supabase متصل":"Supabase غير متصل"},
        telegram:{state:telegram.configured?"CONFIGURED":"NOT_CONFIGURED",label:telegram.configured?"البوت مهيأ":"التنبيهات غير جاهزة"},
        scanner:{state:scannerEnabled?"CONNECTED":"NOT_READY",label:scannerEnabled?"السكانر مفعّل":"السكانر غير جاهز",reason:scannerEnabled?"يفحص كل 60 ثانية؛ النتائج التحليلية لا تنفذ أوامر تلقائيًا.":"يتطلب اتصال MT5 Demo وتهيئة AI."},
        execution:{state:"DISABLED"}
      });
    }
    if (method === "GET" && url.pathname === "/api/config") {
      return sendJson(res,200,{scannerEnabled,scannerIntervalSeconds:60,riskSettings,persisted:Boolean(supabase),aiProviderId:config.aiProviderId,aiModelId:config.aiModelId,environment:"DEMO",liveTradingEnabled:false});
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
    if (method === "GET" && url.pathname === "/api/scanner/log") return sendJson(res,200,{runs:scannerRuns});
    if (method === "GET" && url.pathname === "/api/telegram/chats") {
      return sendJson(res,200,{chats:telegram.listDiscoveredChats().map(chat=>({...chat,enabled:enabledChats.has(chat.chatId)}))});
    }
    if (method === "POST" && url.pathname === "/api/telegram/discover") {
      try { const chats=await telegram.discoverChats(); return sendJson(res,200,{chats:chats.map(chat=>({...chat,enabled:enabledChats.has(chat.chatId)}))}); }
      catch(error) {
        const code=error instanceof TelegramClientError?error.code:"TELEGRAM_ERROR";
        return sendJson(res,503,{error:code,message:error instanceof Error?error.message:"تعذر اكتشاف المحادثات."});
      }
    }
    if (method === "POST" && url.pathname === "/api/telegram/enable") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (typeof body.chatId!=="string" || typeof body.enabled!=="boolean" || !telegram.listDiscoveredChats().some(chat=>chat.chatId===body.chatId)) return sendJson(res,400,{error:"UNKNOWN_CHAT",message:"اكتشف المحادثة أولًا."});
      if (body.enabled) enabledChats.add(body.chatId); else enabledChats.delete(body.chatId);
      return sendJson(res,200,{ok:true,enabled:enabledChats.has(body.chatId),persisted:false});
    }
    if (method === "POST" && url.pathname === "/api/telegram/test") {
      let body;
      try { body=await readJson(req); } catch(error) { return sendJson(res,error.status??400,{error:"INVALID_BODY",message:error.message}); }
      if (typeof body.chatId!=="string" || !telegram.listDiscoveredChats().some(chat=>chat.chatId===body.chatId)) return sendJson(res,400,{error:"UNKNOWN_CHAT",message:"اكتشف المحادثة أولًا."});
      try { const result=await telegram.sendMessage(body.chatId,"اختبار اتصال من XAUUSD AI Trading Bot. هذه رسالة اختبار فقط."); return sendJson(res,200,{ok:true,messageId:result.messageId}); }
      catch(error) { const code=error instanceof TelegramClientError?error.code:"TELEGRAM_ERROR"; return sendJson(res,503,{error:code,message:error instanceof Error?error.message:"تعذر إرسال الرسالة."}); }
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
