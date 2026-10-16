import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRiskSettings } from "./dist/index.js";
import { TelegramBotClient, TelegramClientError, SupabaseRestRepository } from "./dist/index.js";

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
export function createAppServer(env = process.env) {
  const telegram = new TelegramBotClient(env.TELEGRAM_BOT_TOKEN);
  const supabase = configuredSupabase(env);
  const enabledChats = new Set();
  let riskSettings = null;
  let scannerRuns = [];
  const config = { scannerEnabled:false, aiProviderId:env.AI_PROVIDER_ID ?? null, aiModelId:env.AI_MODEL_ID ?? null };
  const server = createServer(async (req,res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/health") {
      let databaseState = "NOT_CONFIGURED";
      if (supabase) {
        try { await supabase.readCurrent(); databaseState = "CONNECTED"; }
        catch { databaseState = "DISCONNECTED"; }
      }
      const marketConfigured = Boolean(env.MT5_BRIDGE_URL);
      const aiConfigured = Boolean(env.AI_API_KEY && env.AI_BASE_URL && env.AI_MODEL_ID);
      return sendJson(res,200,{
        marketData:{state:marketConfigured?"NOT_READY":"NOT_CONFIGURED",label:"MT5 غير متصل",reason:marketConfigured?"تم ضبط عنوان الجسر، لكن لم يتم تأكيد اتصال السوق بعد.":"لم يتم ضبط جسر MT5؛ لا توجد بيانات سوق فعلية."},
        ai:{state:aiConfigured?"CONFIGURED_NOT_TESTED":"NOT_CONFIGURED",label:aiConfigured?"إعدادات موجودة · غير مختبرة":"لم يتم الاتصال",reason:aiConfigured?"وجود الإعدادات لا يعني نجاح الاتصال.":"أضف بيانات المزود على الخادم فقط."},
        database:{state:databaseState,label:databaseState==="CONNECTED"?"Supabase متصل":"Supabase غير متصل"},
        telegram:{state:telegram.configured?"CONFIGURED":"NOT_CONFIGURED",label:telegram.configured?"البوت مهيأ":"التنبيهات غير جاهزة"},
        scanner:{state:"NOT_READY",label:"السكانر غير جاهز",reason:"يتطلب مصدر بيانات MT5 ومحرك تحليل متصلين."},
        execution:{state:"DISABLED"}
      });
    }
    if (method === "GET" && url.pathname === "/api/config") {
      return sendJson(res,200,{scannerEnabled:config.scannerEnabled,scannerIntervalSeconds:60,riskSettings,persisted:Boolean(supabase),aiProviderId:config.aiProviderId,aiModelId:config.aiModelId,environment:"DEMO",liveTradingEnabled:false});
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
      const entry = {at:new Date().toISOString(),status:"NOT_READY",reason:"MT5_MARKET_DATA_NOT_CONNECTED"};
      scannerRuns = [entry,...scannerRuns].slice(0,20);
      return sendJson(res,409,{error:"SCANNER_NOT_READY",message:"تم رفض الفحص بأمان: بيانات MT5 الفعلية غير متصلة. لم يتم توليد إشارة."});
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
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = resolve(root,"."+path);
    if (!target.startsWith(root + sep) && target !== resolve(root,"index.html")) return sendJson(res,404,{error:"NOT_FOUND"});
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
