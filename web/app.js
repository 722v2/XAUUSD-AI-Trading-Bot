const $ = (id) => document.getElementById(id);
const scanLog = [];
const labels = {
  CONNECTED: ["متصل", "ok-tag"], CONFIGURED: ["مهيأ", "ok-tag"], CONFIGURED_NOT_TESTED: ["مهيأ · غير مختبر", "warn-tag"],
  DISCONNECTED: ["غير متصل", "error-tag"], NOT_CONFIGURED: ["غير مهيأ", "muted-tag"], NOT_READY: ["غير جاهز", "warn-tag"],
  DEGRADED: ["متدهور", "warn-tag"], HEALTHY: ["سليم", "ok-tag"], DISABLED: ["معطّل", "muted-tag"]
};
function setStatus(id, state, fallback) {
  const node = $(id); const [label, css] = labels[state] || [fallback || state, "muted-tag"];
  node.textContent = label; node.className = "status-tag " + css;
}
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
$("scan-now").addEventListener("click",async () => {
  $("scan-now").disabled = true; $("scan-result").textContent = "جارٍ التحقق من جاهزية البيانات…";
  try {
    const result = await api("/api/scan",{method:"POST",body:"{}"});
    $("scan-result").textContent = result.message;
    addScanLog("فحص يدوي",result.status || "مكتمل",result.message);
    await loadScanLog(); await loadPositions();
  } catch(error) {
    const message = error.data?.message || error.message;
    $("scan-result").textContent = message;
    addScanLog("فحص يدوي","مرفوض بأمان",message);
    await loadScanLog();
  } finally { $("scan-now").disabled = false; }
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
      $("scan-result").textContent = result.state === "CONFIRMED" ? "تم تأكيد تعديل SL/TP." : "نتيجة التعديل تحتاج مصالحة.";
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
      $("scan-result").textContent = result.state === "CONFIRMED" ? "تم تأكيد طلب الإغلاق من الوسيط." : "نتيجة الإغلاق تحتاج مصالحة؛ لن يعاد إرسال الطلب تلقائيًا.";
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
refreshHealth(); loadConfig(); loadTelegramChats(); loadScanLog(); loadPositions();
