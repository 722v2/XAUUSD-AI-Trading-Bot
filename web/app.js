const $ = (id) => document.getElementById(id);
const scanLog = [];
const labels = {
  CONNECTED: ["متصل", "ok-tag"], CONFIGURED: ["مهيأ", "ok-tag"], CONFIGURED_NOT_TESTED: ["مهيأ · غير مختبر", "warn-tag"],
  DISCONNECTED: ["غير متصل", "error-tag"], NOT_CONFIGURED: ["غير مهيأ", "muted-tag"], NOT_READY: ["غير جاهز", "warn-tag"],
  DEGRADED: ["متدهور", "warn-tag"], HEALTHY: ["سليم", "ok-tag"], DISABLED: ["معطّل", "muted-tag"], ARMED_DEMO: ["مفعّل · Demo", "warn-tag"]
};
function setStatus(id, state, fallback) {
  const node = $(id); const [label, css] = labels[state] || [fallback || state, "muted-tag"];
  node.textContent = label; node.className = "status-tag " + css;
}
let nextScanAtMs=null;
function timeNow() { return new Intl.DateTimeFormat("ar-JO",{hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date()); }
async function api(path, options = {}) {
  const response = await fetch(path,{...options,headers:{"content-type":"application/json",...(options.headers||{})}});
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(new Error(data.message || data.error || "تعذر إكمال الطلب"),{data,status:response.status});
  return data;
}
function addScanLog(stage,status,details) {
  scanLog.unshift({time:timeNow(),stage,status,details}); scanLog.splice(12);
  $("scan-log").innerHTML = scanLog.length ? scanLog.map(item => `<tr><td>${escapeHtml(item.time)}</td><td>${escapeHtml(item.stage)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.details)}</td></tr>`).join("") : '<tr><td colspan="4" class="empty">لا توجد دورات فحص مسجلة.</td></tr>';
}
async function refreshHealth() {
  try {
    const health = await api("/api/health");
    setStatus("market-status",health.marketData.state);
    $("market-value").textContent = health.marketData.label;
    setStatus("ai-status",health.ai.state);
    $("ai-value").textContent = health.ai.label;
    setStatus("db-status",health.database.state);
    $("db-value").textContent = health.database.label;
    setStatus("telegram-status",health.telegram.state);
    $("telegram-value").textContent = health.telegram.label;
    setStatus("scanner-status",health.scanner.state);
    setStatus("execution-status",health.execution.state);
    nextScanAtMs=health.scanner.nextScanAt?Date.parse(health.scanner.nextScanAt):null;
    updateCountdown();
    $("scanner-toggle").textContent = health.scanner.state === "CONNECTED" ? "إيقاف السكانر" : "تشغيل السكانر";
    $("auto-trading-toggle").textContent = health.execution.state === "ARMED_DEMO" ? "إيقاف التنفيذ الآلي (Demo)" : "تفعيل التنفيذ الآلي (Demo)";
    $("scanner-title").textContent = health.scanner.label;
    $("scanner-detail").textContent = health.scanner.reason;
    $("mt5-title").textContent = health.marketData.label;
    $("mt5-detail").textContent = health.marketData.reason;
    $("last-updated").textContent = "آخر تحديث " + timeNow();
    $("persistence-label").textContent = health.database.state === "CONNECTED" ? "التخزين الدائم متصل" : "تخزين مؤقت داخل الخادم";
    $("persistence-label").className = "status-tag " + (health.database.state === "CONNECTED" ? "ok-tag" : "warn-tag");
  } catch (error) {
    $("last-updated").textContent = "تعذر جلب الحالة";
    $("system-notice").querySelector("p").textContent = error.message;
  }
}
function updateRiskMode() {
  const percent = $("risk-mode").value === "PERCENT_OF_CAPITAL";
  $("risk-percent-label").hidden = !percent;
  $("risk-cash-label").hidden = percent;
  $("risk-percent").required = percent;
  $("risk-cash").required = !percent;
}
let aiProviders = [];
let selectedAiModelId = null;
function renderAIModels(preferredModelId) {
  const provider=aiProviders.find(item=>item.id===$("ai-provider").value);
  const select=$("ai-model");
  const models=provider?.models||[];
  select.innerHTML=models.map(model=>`<option value="${escapeHtml(model.id)}">${escapeHtml(model.label||model.id)}</option>`).join("");
  select.disabled=models.length===0;
  const wanted=preferredModelId&&models.some(model=>model.id===preferredModelId)?preferredModelId:models[0]?.id;
  if(wanted) select.value=wanted;
}
function renderBacktestModels(preferredModelId) {
  const provider=aiProviders.find(item=>item.id===$("backtest-provider").value&&item.configured);
  const select=$("backtest-model");
  const models=provider?.models||[];
  select.innerHTML=models.map(model=>`<option value="${escapeHtml(model.id)}">${escapeHtml(model.label||model.id)}</option>`).join("");
  select.disabled=models.length===0;
  const wanted=preferredModelId&&models.some(model=>model.id===preferredModelId)?preferredModelId:models[0]?.id;
  if(wanted) select.value=wanted;
}
function initializeBacktestProviders(preferredProviderId, preferredModelId) {
  const configured=aiProviders.filter(provider=>provider.configured);
  const select=$("backtest-provider");
  select.innerHTML=configured.map(provider=>`<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label)}</option>`).join("");
  select.disabled=configured.length===0;
  const selected=configured.find(provider=>provider.id===preferredProviderId)||configured[0];
  if(selected) select.value=selected.id;
  renderBacktestModels(selected?.id===preferredProviderId?preferredModelId:null);
  $("backtest-status").textContent=configured.length?"اختر النموذج والإعدادات":"لا يوجد مزود AI مهيأ";
  $("backtest-status").className="status-tag "+(configured.length?"ok-tag":"warn-tag");
}
$("backtest-provider").addEventListener("change",()=>renderBacktestModels(null));
async function loadAIProviders() {
  try {
    const data=await api("/api/ai/providers");
    aiProviders=data.providers||[];
    const select=$("ai-provider");
    select.innerHTML=aiProviders.map(provider=>`<option value="${escapeHtml(provider.id)}" >${escapeHtml(provider.label)}${provider.configured?"":" — يحتاج مفتاح API على Render"}</option>`).join("");
    select.disabled=!aiProviders.length;
    const selected=aiProviders.find(provider=>provider.id===data.selectedProviderId&&provider.configured)||aiProviders.find(provider=>provider.configured)||aiProviders[0];
    if(selected) select.value=selected.id;
    selectedAiModelId=data.selectedModelId||null;
    renderAIModels(selected?.id===data.selectedProviderId?selectedAiModelId:null);
    initializeBacktestProviders(data.selectedProviderId,selectedAiModelId);
    $("ai-config-status").textContent=data.persisted?"الإعدادات الدائمة متاحة":"حفظ مؤقت";
    $("ai-config-status").className="status-tag "+(data.persisted?"ok-tag":"warn-tag");
    $("ai-config-feedback").textContent=aiProviders.length?"المفاتيح تبقى في بيئة الخادم؛ القائمة لا تسمح بعنوان مزود عشوائي.":"أضف AI_BASE_URL وAI_MODEL_ID أو AI_PROVIDER_CATALOG_JSON إلى بيئة الخادم.";
    $("ai-config-form").querySelector('button[type="submit"]').disabled=false;
    if (!aiProviders.some(provider=>provider.configured)) {
      $("ai-config-feedback").textContent="القائمة جاهزة للاختيار، لكن يلزم إضافة OPENROUTER_API_KEY في Render → Environment لتفعيل OpenRouter.";
      $("ai-config-status").textContent="ينقص مفتاح API";
      $("ai-config-status").className="status-tag warn-tag";
    }
  } catch(error) {
    $("ai-config-feedback").textContent=error.message||"تعذر تحميل قائمة مزودي AI.";
    $("ai-config-form").querySelector('button[type="submit"]').disabled=true;
  }
}
$("ai-provider").addEventListener("change",()=>renderAIModels(null));
$("ai-config-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const feedback=$("ai-config-feedback");
  feedback.textContent="جارٍ حفظ اختيار AI…";
  try {
    const result=await api("/api/ai/config",{method:"POST",body:JSON.stringify({providerId:$("ai-provider").value,modelId:$("ai-model").value})});
    feedback.textContent=result.message;
    selectedAiModelId=result.modelId;
    await loadAIProviders();
    await refreshHealth();
  } catch(error) { feedback.textContent=error.data?.message||error.message; }
});
async function loadConfig() {
  try {
    const config = await api("/api/config");
    if (config.riskSettings) {
      $("capital").value = config.riskSettings.referenceCapital;
      $("risk-mode").value = config.riskSettings.mode;
      $("risk-percent").value = config.riskSettings.riskPercent ?? "";
      $("risk-cash").value = config.riskSettings.riskCash ?? "";
      $("min-rr").value = config.riskSettings.minimumRiskRewardRatio;
    }
    updateRiskMode();
    $("scanner-toggle").textContent = config.scannerEnabled ? "إيقاف السكانر" : "تشغيل السكانر";
    $("auto-trading-toggle").textContent = config.autoTradingEnabled ? "إيقاف التنفيذ الآلي (Demo)" : "تفعيل التنفيذ الآلي (Demo)";
    await loadAIProviders();
  } catch {}
}
$("risk-mode").addEventListener("change",updateRiskMode);
$("risk-form").addEventListener("submit",async event => {
  event.preventDefault();
  const mode = $("risk-mode").value;
  const settings = {
    mode, referenceCapital:Number($("capital").value),
    minimumRiskRewardRatio:Number($("min-rr").value),
    ...(mode === "PERCENT_OF_CAPITAL" ? {riskPercent:Number($("risk-percent").value)} : {riskCash:Number($("risk-cash").value)})
  };
  const feedback = $("risk-feedback"); feedback.textContent = "جارٍ التحقق…";
  try {
    const result = await api("/api/config/risk",{method:"POST",body:JSON.stringify(settings)});
    feedback.textContent = result.persisted ? "تم التحقق والحفظ الدائم." : "تم التحقق؛ الحفظ مؤقت داخل الخادم فقط.";
    $("persistence-label").textContent = result.persisted ? "محفوظ دائمًا" : "غير محفوظ دائمًا";
    await refreshHealth();
  } catch(error) { feedback.textContent = error.message; }
});
$("scanner-toggle").addEventListener("click",async () => {
  const enabled = $("scanner-toggle").textContent.includes("تشغيل");
  $("scanner-toggle").disabled = true;
  try {
    await api("/api/scanner/enabled",{method:"POST",body:JSON.stringify({enabled})});
    $("scan-result").textContent = enabled ? "تم تفعيل الفحص الدوري كل 60 ثانية." : "تم إيقاف الفحص الدوري.";
    await refreshHealth(); await loadConfig();
  } catch(error) { $("scan-result").textContent = error.data?.message || error.message; }
  finally { $("scanner-toggle").disabled = false; }
});
async function loadScanLog() {
  try {
    const data = await api("/api/scanner/log");
    scanLog.length = 0;
    for (const run of data.runs || []) scanLog.push({time:run.at ? new Date(run.at).toLocaleTimeString("ar-JO") : "—",stage:run.triggerType === "SCHEDULED" ? "دوري" : "يدوي",status:run.status || "—",details:run.reason || "—"});
    $("scan-log").innerHTML = scanLog.length ? scanLog.map(item => `<tr><td>${escapeHtml(item.time)}</td><td>${escapeHtml(item.stage)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.details)}</td></tr>`).join("") : '<tr><td colspan="4" class="empty">لا توجد دورات فحص مسجلة.</td></tr>';
  } catch {}
}
$("auto-trading-toggle").addEventListener("click",async () => {
  const enabled = $("auto-trading-toggle").textContent.includes("تفعيل");
  $("auto-trading-toggle").disabled = true;
  try {
    await api("/api/trading/auto",{method:"POST",body:JSON.stringify({enabled})});
    $("scan-result").textContent = enabled ? "تم تفعيل التنفيذ الآلي على Demo. التداول الحقيقي ما زال معطّلًا." : "تم إيقاف التنفيذ الآلي.";
    await refreshHealth(); await loadConfig();
  } catch(error) { $("scan-result").textContent = error.data?.message || error.message; }
  finally { $("auto-trading-toggle").disabled = false; }
});
function updateCountdown() {
  const el=$("scanner-countdown");
  if(!nextScanAtMs || !Number.isFinite(nextScanAtMs)){el.textContent="—";return;}
  const seconds=Math.ceil((nextScanAtMs-Date.now())/1000);
  if(seconds<=0){el.textContent="جارٍ الفحص";return;}
  el.textContent=String(Math.floor(seconds/60)).padStart(2,"0")+":"+String(seconds%60).padStart(2,"0");
}
function renderAnalysis(data) {
  if(!data || typeof data!=="object") return;
  const candles=Array.isArray(data.chartCandles)?data.chartCandles.filter(c=>c&&[c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.high>=c.low):[];
  if(candles.length>=2) {
    const svg=$("price-chart"); svg.replaceChildren();
    const ns="http://www.w3.org/2000/svg", width=900,height=280,left=52,right=18,top=18,bottom=26;
    const plotW=width-left-right,plotH=height-top-bottom;
    const lo=Math.min(...candles.map(c=>c.low)),hi=Math.max(...candles.map(c=>c.high));
    const span=Math.max(hi-lo,0.000001);
    const y=value=>top+(hi-value)/span*plotH;
    const add=(tag,attrs,text)=>{
      const node=document.createElementNS(ns,tag);
      for(const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value));
      if(text!==undefined) node.textContent=String(text);
      svg.appendChild(node);return node;
    };
    svg.setAttribute("viewBox",`0 0 ${width} ${height}`);
    for(let i=0;i<=4;i++){
      const gy=top+i*plotH/4, price=hi-i*span/4;
      add("line",{x1:left,y1:gy,x2:width-right,y2:gy,stroke:"#263344","stroke-width":1});
      add("text",{x:left-8,y:gy+4,"text-anchor":"end",fill:"#8d9bb0","font-size":11},price.toFixed(2));
    }
    const step=plotW/candles.length,bodyW=Math.max(2,Math.min(10,step*0.62));
    candles.forEach((c,i)=>{
      const x=left+(i+0.5)*step, bullish=c.close>=c.open, color=bullish?"#37c88a":"#f06b78";
      add("line",{x1:x,y1:y(c.high),x2:x,y2:y(c.low),stroke:color,"stroke-width":1.3});
      const topY=Math.min(y(c.open),y(c.close)), bodyH=Math.max(1,Math.abs(y(c.open)-y(c.close)));
      add("rect",{x:x-bodyW/2,y:topY,width:bodyW,height:bodyH,rx:0.6,fill:color});
    });
  }
  const analysis=data.analysis||{}, metrics=analysis.metrics||{}, evidence=Array.isArray(analysis.evidence)?analysis.evidence:[];
  const primary=evidence[0]||{}, decision=data.decision||{}, assessment=data.assessment||{};
  $("selected-strategy").textContent=primary.strategyId||decision.outcome||data.status||"لا توجد فرصة";
  $("selected-strategy").className="status-tag "+(primary.strategyId?"ok-tag":"muted-tag");
  if(analysis.latestClosedBarTime) $("chart-caption").textContent="آخر شمعة مغلقة: "+new Date(analysis.latestClosedBarTime).toLocaleTimeString();
  else if(data.message) $("chart-caption").textContent=data.message;
  const metricRows=[
    ["الحالة",analysis.status||data.status||data.error||"—"],
    ["النظام",metrics.marketRegime||"—"],
    ["قوة الاتجاه",Number.isFinite(metrics.trendStrength)?metrics.trendStrength.toFixed(3):"—"],
    ["EMA 9",Number.isFinite(metrics.ema9)?metrics.ema9.toFixed(2):"—"],
    ["EMA 21",Number.isFinite(metrics.ema21)?metrics.ema21.toFixed(2):"—"],
    ["RSI 14",Number.isFinite(metrics.rsi14)?metrics.rsi14.toFixed(2):"—"],
    ["MACD Histogram",Number.isFinite(metrics.macdHistogram)?metrics.macdHistogram.toFixed(4):"—"],
    ["ATR 14",Number.isFinite(metrics.atr14)?metrics.atr14.toFixed(3):"—"],
    ["M5 / M15 / H1",metrics.higherTimeframeContext?[metrics.higherTimeframeContext.M5,metrics.higherTimeframeContext.M15,metrics.higherTimeframeContext.H1].join(" / "):"—"],
    ["الدخول / SL / TP",primary.entryPrice?[primary.entryPrice,primary.stopLoss,primary.takeProfit].map(v=>Number(v).toFixed(2)).join(" / "):"—"],
    ["قرار AI",assessment.outcome||"—"]
  ];
  const metricsEl=$("analysis-metrics");metricsEl.replaceChildren();
  for(const [label,value] of metricRows){
    const row=document.createElement("div"),dt=document.createElement("dt"),dd=document.createElement("dd");
    dt.textContent=label;dd.textContent=value;row.append(dt,dd);metricsEl.appendChild(row);
  }
  const codes=[...(primary.evidenceCodes||[]),...(assessment.rationaleCodes||[]),...(decision.reasonCodes||[])];
  const list=$("analysis-evidence");list.replaceChildren();
  if(!codes.length){
    const li=document.createElement("li");li.textContent=data.message||analysis.reason||"لا توجد أدلة كافية لإصدار فرصة.";list.appendChild(li);
  } else {
    for(const code of [...new Set(codes)]){
      const li=document.createElement("li");li.textContent=code;list.appendChild(li);
    }
  }
}
async function loadLatestScan() {
  try {
    const data=await api("/api/scanner/latest");
    if(data.scan?.body) renderAnalysis(data.scan.body);
  } catch {}
}
$("scan-now").addEventListener("click",async () => {
  $("scan-now").disabled = true; $("scan-result").textContent = "جارٍ التحقق من جاهزية البيانات…";
  try {
    const result = await api("/api/scan",{method:"POST",body:"{}"});
    $("scan-result").textContent = result.message;
    renderAnalysis(result);
    addScanLog("فحص يدوي",result.status || "مكتمل",result.message);
    await loadScanLog(); await loadPositions();
  } catch(error) {
    const message = error.data?.message || error.message;
    renderAnalysis(error.data);
    $("scan-result").textContent = message;
    addScanLog("فحص يدوي","مرفوض بأمان",message);
    await loadScanLog();
  } finally { $("scan-now").disabled = false; }
});
function renderBacktestResult(result) {
  const metrics=result.metrics||{}, data=result.data||{}, ai=result.ai||{};
  const money=value=>Number.isFinite(value)?value.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}):"—";
  const stats=[
    ["النموذج",ai.modelId||"—"],["الشموع المستلمة",String(data.receivedBars??0)],
    ["الإشارات الفنية",String(metrics.candidateSignals??0)],["طلبات AI",String(metrics.aiCalls??0)],
    ["الصفقات",String(metrics.trades??0)],["نسبة النجاح",String(metrics.winRatePercent??0)+"%"],
    ["صافي الربح / الخسارة",money(metrics.netPnl)],["أقصى تراجع",money(metrics.maxDrawdown)],
    ["Profit Factor",metrics.profitFactor==null?"—":String(metrics.profitFactor)],
    ["متوسط الصفقة",money(metrics.expectancyPerTrade)],["رفض AI",String(metrics.aiRejected??0)],
    ["أخطاء AI",String(metrics.aiErrors??0)],["تقييمات لم تُنفذ بسبب الحد",String(metrics.aiCallsSkippedByLimit??0)]
  ];
  $("backtest-summary").innerHTML=stats.map(([label,value])=>`<div class="backtest-stat"><span>${escapeHtml(label)}</span><b class="${label==="صافي الربح / الخسارة"?(Number(metrics.netPnl)>=0?"profit-text":"loss-text"):""}">${escapeHtml(value)}</b></div>`).join("");
  const start=data.startTime?new Date(data.startTime).toLocaleString():"—";
  const end=data.endTime?new Date(data.endTime).toLocaleString():"—";
  const assumptions=result.assumptions||{};
  $("backtest-data-note").textContent=`مصدر البيانات: MT5 Bridge · ${start} — ${end} · السبريد ${assumptions.spreadPrice??"—"} · الانزلاق ${assumptions.slippagePrice??"—"} · العمولة لكل Lot ${assumptions.commissionPerLotRoundTurn??"—"} · لا توجد أوامر تداول.`;
  const trades=Array.isArray(result.trades)?result.trades:[];
  $("backtest-trades").innerHTML=trades.length?trades.slice().reverse().map(trade=>`<tr><td>${escapeHtml(new Date(trade.signalTime).toLocaleString())}</td><td>${trade.direction==="BUY"?"شراء":"بيع"}</td><td>${escapeHtml(trade.strategyId)}</td><td>${escapeHtml(trade.entryPrice)}</td><td>${escapeHtml(trade.exitPrice)}</td><td>${escapeHtml(trade.exitReason)}</td><td class="${trade.netPnl>=0?"profit-text":"loss-text"}">${escapeHtml(money(trade.netPnl))}</td><td>${escapeHtml(trade.rMultiple)}</td></tr>`).join(""):'<tr><td colspan="8" class="empty">لم ينتج الاختبار صفقات متوافقة مع قرار AI ضمن الإعدادات الحالية.</td></tr>';
  $("backtest-results").hidden=false;
}
$("backtest-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const button=$("backtest-run"),feedback=$("backtest-feedback");
  const providerId=$("backtest-provider").value,modelId=$("backtest-model").value;
  if(!providerId||!modelId){feedback.textContent="اختر مزود AI ونموذجًا مضبوطًا على الخادم.";return;}
  const spreadText=$("backtest-spread").value.trim();
  const request={
    providerId,modelId,barsCount:Number($("backtest-bars").value),lots:Number($("backtest-lots").value),
    spreadPrice:spreadText===""?null:Number(spreadText),
    slippagePrice:Number($("backtest-slippage").value),commissionPerLot:Number($("backtest-commission").value),maxAiCalls:Number($("backtest-max-ai").value)
  };
  button.disabled=true;
  $("backtest-results").hidden=true;
  $("backtest-status").textContent="جارٍ الاختبار";
  $("backtest-status").className="status-tag warn-tag";
  feedback.textContent="جارٍ سحب الشموع المغلقة من MT5 ثم اختبار المرشحين على النموذج المختار. قد يستغرق ذلك وقتًا بحسب عدد طلبات AI.";
  try{
    const result=await api("/api/backtest",{method:"POST",body:JSON.stringify(request)});
    renderBacktestResult(result);
    const m=result.metrics||{};
    feedback.textContent=`اكتمل الاختبار. ${m.trades??0} صفقة، ${m.aiCalls??0} تقييم AI، وصافي النتيجة ${m.netPnl??0}.`;
    $("backtest-status").textContent="اكتمل الاختبار";
    $("backtest-status").className="status-tag ok-tag";
  }catch(error){
    feedback.textContent=error.data?.message||error.message||"فشل الاختبار التاريخي.";
    $("backtest-status").textContent="فشل / غير جاهز";
    $("backtest-status").className="status-tag error-tag";
  }finally{button.disabled=false;}
});
async function loadTelegramChats() {
  try {
    const data = await api("/api/telegram/chats");
    $("telegram-chat-count").textContent = data.chats.length + " محادثات";
    $("telegram-chats").innerHTML = data.chats.length ? data.chats.map(chat => `<div class="chat-row"><span class="chat-avatar">➤</span><div class="chat-copy"><b>${escapeHtml(chat.title)}</b><small>${escapeHtml(chat.type)} · ID: ${escapeHtml(chat.chatId)}</small></div><label class="chat-toggle"><input type="checkbox" data-chat-id="${escapeHtml(chat.chatId)}" ${chat.enabled ? "checked" : ""}> تفعيل</label><button class="secondary-button" data-test-chat="${escapeHtml(chat.chatId)}">اختبار</button></div>`).join("") : '<p class="empty">لم يتم اكتشاف محادثات. أرسل رسالة للبوت أولًا.</p>';
  } catch(error) { $("telegram-feedback").textContent = error.message; }
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
$("discover-chats").addEventListener("click",async () => {
  $("telegram-feedback").textContent = "جارٍ طلب التحديثات من Telegram…";
  try {
    const result = await api("/api/telegram/discover",{method:"POST",body:"{}"});
    $("telegram-feedback").textContent = "اكتمل الاكتشاف. عدد المحادثات: " + result.chats.length;
    await loadTelegramChats(); await refreshHealth();
  } catch(error) { $("telegram-feedback").textContent = error.message; }
});
async function loadPositions() {
  const body = $("positions-table");
  try {
    const data = await api("/api/positions");
    const positions = data.positions || [];
    const warning = $("positions-warning");
    warning.hidden = !data.ownershipConflict;
    warning.textContent = data.ownershipConflict ? "تم رصد مركز XAUUSD لا يمكن تأكيد ملكيته للبوت. التنفيذ الآلي محظور حتى تتم مراجعة هذا المركز يدويًا." : "";
    body.innerHTML = positions.length ? positions.map(position => `<tr data-position-row="${position.ticket}"><td>${escapeHtml(position.ticket)}</td><td>${position.direction==="BUY"?"شراء":"بيع"}</td><td>${escapeHtml(position.volume)}</td><td>${escapeHtml(position.entryPrice)}</td><td><input class="position-sl" type="number" step="any" min="0.000001" value="${escapeHtml(position.stopLoss)}" aria-label="وقف الخسارة"></td><td><input class="position-tp" type="number" step="any" min="0.000001" value="${escapeHtml(position.takeProfit)}" aria-label="جني الربح"></td><td class="${position.profit>=0?"profit-text":"loss-text"}">${escapeHtml(position.profit)}</td><td><div class="position-actions"><button class="secondary-button" data-modify-position="${escapeHtml(position.ticket)}">حفظ SL/TP</button><button class="danger-button" data-close-position="${escapeHtml(position.ticket)}">إغلاق</button></div></td></tr>`).join("") : '<tr><td colspan="8" class="empty">لا توجد صفقات بوت مفتوحة.</td></tr>';
  } catch(error) {
    body.innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(error.message || "MT5 غير متصل")}</td></tr>`;
  }
}
$("positions-table").addEventListener("click",async event => {
  const modify = event.target.closest("button[data-modify-position]");
  const close = event.target.closest("button[data-close-position]");
  if (modify) {
    const row = modify.closest("tr"); modify.disabled = true;
    try {
      const result = await api("/api/positions/modify",{method:"POST",body:JSON.stringify({ticket:Number(modify.dataset.modifyPosition),stopLoss:Number(row.querySelector(".position-sl").value),takeProfit:Number(row.querySelector(".position-tp").value)})});
      $("scan-result").textContent = result.state === "CONFIRMED" ? (result.persisted===false ? "تم تأكيد تعديل SL/TP لدى الوسيط، لكن التخزين الدائم لم يتأكد." : "تم تأكيد تعديل SL/TP.") : "نتيجة التعديل تحتاج مصالحة.";
      await loadPositions();
    } catch(error) { $("scan-result").textContent = error.data?.message || error.message; }
    finally { modify.disabled = false; }
  }
  if (close) {
    const ticket = Number(close.dataset.closePosition);
    if (!window.confirm("تأكيد إغلاق صفقة البوت رقم " + ticket + " على حساب Demo؟")) return;
    close.disabled = true;
    try {
      const result = await api("/api/positions/close",{method:"POST",body:JSON.stringify({ticket})});
      $("scan-result").textContent = result.state === "CONFIRMED" ? (result.persisted===false ? "تم تأكيد الإغلاق لدى الوسيط، لكن التخزين الدائم لم يتأكد." : "تم تأكيد طلب الإغلاق من الوسيط.") : "نتيجة الإغلاق تحتاج مصالحة؛ لن يعاد إرسال الطلب تلقائيًا.";
      await loadPositions();
    } catch(error) { $("scan-result").textContent = error.data?.message || error.message; }
    finally { close.disabled = false; }
  }
});
$("telegram-chats").addEventListener("change",async event => {
  const input = event.target.closest("input[data-chat-id]"); if (!input) return;
  try { await api("/api/telegram/enable",{method:"POST",body:JSON.stringify({chatId:input.dataset.chatId,enabled:input.checked})}); }
  catch(error) { input.checked = !input.checked; $("telegram-feedback").textContent = error.message; }
});
$("telegram-chats").addEventListener("click",async event => {
  const button = event.target.closest("button[data-test-chat]"); if (!button) return;
  button.disabled = true;
  try { await api("/api/telegram/test",{method:"POST",body:JSON.stringify({chatId:button.dataset.testChat})}); $("telegram-feedback").textContent = "تم إرسال رسالة الاختبار."; }
  catch(error) { $("telegram-feedback").textContent = error.message; }
  finally { button.disabled = false; }
});
$("refresh").addEventListener("click",async () => { await refreshHealth(); await loadTelegramChats(); await loadPositions(); });
document.querySelectorAll(".nav-link").forEach(link => link.addEventListener("click",() => {
  document.querySelectorAll(".nav-link").forEach(item=>item.classList.remove("active")); link.classList.add("active");
}));
updateRiskMode();
refreshHealth(); loadConfig(); loadTelegramChats(); loadScanLog(); loadPositions(); loadLatestScan();
setInterval(()=>{void refreshHealth();},10000);
setInterval(updateCountdown,1000);
setInterval(()=>{void loadLatestScan();void loadScanLog();void loadPositions();},15000);


// Real page navigation: each sidebar item shows a dedicated workspace view.
const dashboardPages = {
  overview: { title: "نظرة عامة", sections: ["overview"], notice: true },
  scanner: { title: "السكانر والتحليل", sections: ["scanner"] },
  backtest: { title: "الاختبار التاريخي", sections: ["backtest"] },
  risk: { title: "المخاطر ورأس المال", sections: ["risk"] },
  mt5: { title: "اتصال MT5", sections: ["mt5"] },
  trades: { title: "الصفقات والسجل", sections: ["trades"] },
  telegram: { title: "Telegram", sections: ["telegram"] },
  settings: { title: "الإعدادات", sections: ["settings", "ai-config"] }
};
function pageFromHash() {
  const raw = location.hash.replace(/^#/, "");
  if (raw.startsWith("page=") && dashboardPages[raw.slice(5)]) return raw.slice(5);
  const legacy = raw.toLowerCase();
  return Object.keys(dashboardPages).find(key => dashboardPages[key].sections.includes(legacy)) || "overview";
}
function showDashboardPage(pageKey, updateUrl = false) {
  const page = dashboardPages[pageKey] || dashboardPages.overview;
  document.querySelectorAll(".main > .section").forEach(section => {
    section.hidden = !page.sections.includes(section.id);
  });
  const notice = $("system-notice");
  if (notice) notice.hidden = !page.notice;
  document.querySelectorAll(".nav-link[data-page]").forEach(link => {
    const active = link.dataset.page === pageKey;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const title = $("page-title");
  if (title) title.textContent = page.title;
  const eyebrow = document.querySelector(".topbar .eyebrow");
  if (eyebrow) eyebrow.textContent = "لوحة التحكم / " + page.title;
  if (updateUrl && location.hash !== "#page=" + pageKey) history.pushState({ page: pageKey }, "", "#page=" + pageKey);
  window.scrollTo({ top: 0, behavior: "auto" });
}
function initDashboardNavigation() {
  document.querySelectorAll(".nav-link[data-page]").forEach(link => {
    link.addEventListener("click", event => {
      event.preventDefault();
      showDashboardPage(link.dataset.page, true);
    });
  });
  window.addEventListener("hashchange", () => showDashboardPage(pageFromHash(), false));
  window.addEventListener("popstate", () => showDashboardPage(pageFromHash(), false));
  showDashboardPage(pageFromHash(), false);
}
initDashboardNavigation();
