function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function round(value, digits = 2) { const scale = 10 ** digits; return Math.round((value + Number.EPSILON) * scale) / scale; }
function closedBefore(candles, timeMs) { return candles.filter(bar => Date.parse(bar.closeTime) <= timeMs); }
function simulateTrade(candidate, bars, spreadPrice, lots, tickSize, tickValuePerLot, commissionPerLot) {
  const entryIndex = candidate.index + 1;
  if (entryIndex >= bars.length) return null;
  const signal = candidate.evidence;
  const stopDistance = signal.direction === "BUY" ? signal.entryPrice - signal.stopLoss : signal.stopLoss - signal.entryPrice;
  const targetDistance = signal.direction === "BUY" ? signal.takeProfit - signal.entryPrice : signal.entryPrice - signal.takeProfit;
  if (!(stopDistance > 0 && targetDistance > 0)) return null;
  const entryBar = bars[entryIndex];
  const entryPrice = signal.direction === "BUY" ? entryBar.open + spreadPrice : entryBar.open;
  // MT5 chart OHLC is bid-based: BUY exits are checked on bid; SELL exits on ask.
  const stopLoss = signal.direction === "BUY" ? entryBar.open - stopDistance : entryBar.open + spreadPrice + stopDistance;
  const takeProfit = signal.direction === "BUY" ? entryBar.open + targetDistance : entryBar.open + spreadPrice - targetDistance;
  let exitPrice = null, exitReason = "DATA_END", exitIndex = bars.length - 1;
  for (let i = entryIndex; i < bars.length; i++) {
    const bar = bars[i];
    const high = signal.direction === "SELL" ? bar.high + spreadPrice : bar.high;
    const low = signal.direction === "SELL" ? bar.low + spreadPrice : bar.low;
    const stopHit = signal.direction === "BUY" ? low <= stopLoss : high >= stopLoss;
    const targetHit = signal.direction === "BUY" ? high >= takeProfit : low <= takeProfit;
    // If both levels fall inside one candle, assume the adverse stop was hit first.
    if (stopHit) { exitPrice = stopLoss; exitReason = targetHit ? "SL_AND_TP_SAME_BAR_SL_FIRST" : "STOP_LOSS"; exitIndex = i; break; }
    if (targetHit) { exitPrice = takeProfit; exitReason = "TAKE_PROFIT"; exitIndex = i; break; }
  }
  if (exitPrice === null) {
    const last = bars[bars.length - 1];
    exitPrice = signal.direction === "BUY" ? last.close : last.close + spreadPrice;
  }
  const signedMove = signal.direction === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;
  const grossPnl = signedMove / tickSize * tickValuePerLot * lots;
  const commission = commissionPerLot * lots;
  const netPnl = grossPnl - commission;
  return {
    signalTime: signal.createdAt, entryTime: entryBar.openTime, exitTime: bars[exitIndex].closeTime,
    direction: signal.direction, strategyId: signal.strategyId, aiOutcome: candidate.aiOutcome,
    entryPrice: round(entryPrice, 3), stopLoss: round(stopLoss, 3), takeProfit: round(takeProfit, 3),
    exitPrice: round(exitPrice, 3), exitReason, lots: round(lots, 4),
    grossPnl: round(grossPnl, 2), commission: round(commission, 2), netPnl: round(netPnl, 2),
    rMultiple: round(netPnl / (((stopDistance + spreadPrice) / tickSize * tickValuePerLot * lots + commission) || 1), 3),
    _exitIndex: exitIndex
  };
}

/**
 * Historical simulation over closed MT5 candles. It never uses a candle before its close
 * and enters at the next candle open. The AI adapter is the same server-configured model
 * selected in the dashboard; this function has no order/execution dependencies.
 */
export async function runHistoricalBacktest(input) {
  const { bridge, aiProvider, aiProviderId, aiModelId, request, normalizeClosedCandles, analyzeClosedMarket, coordinateTechnicalAndAI } = input;
  if (!bridge) throw Object.assign(new Error("جسر MT5 غير مضبوط على الخادم."), { status: 409, code: "MT5_NOT_CONFIGURED" });
  if (!aiProvider) throw Object.assign(new Error("اختر نموذج AI مضبوطًا على الخادم أولًا."), { status: 409, code: "AI_NOT_CONFIGURED" });
  const barsCount = request.barsCount;
  const lots = request.lots;
  const spreadPrice = request.spreadPrice;
  const commissionPerLot = request.commissionPerLot;
  const maxAiCalls = request.maxAiCalls;
  if (!Number.isInteger(barsCount) || barsCount < 100 || barsCount > 1000 ||
      !finite(lots) || lots <= 0 || lots > 100 ||
      !finite(spreadPrice) || spreadPrice < 0 || spreadPrice > 100 ||
      !finite(commissionPerLot) || commissionPerLot < 0 || commissionPerLot > 10000 ||
      !Number.isInteger(maxAiCalls) || maxAiCalls < 1 || maxAiCalls > 100) {
    throw Object.assign(new Error("إعدادات الاختبار غير صالحة. الشموع 100–1000، وعدد تقييمات AI من 1 إلى 100."), { status: 400, code: "INVALID_BACKTEST_CONFIG" });
  }
  const health = await bridge.health();
  if (!health.ok || health.value.state !== "CONNECTED" || health.value.environment !== "DEMO") {
    throw Object.assign(new Error("يجب اتصال جسر MT5 بحساب Demo قبل سحب البيانات التاريخية."), { status: 409, code: "MT5_DEMO_NOT_READY" });
  }
  const contextCounts = {
    M5: Math.min(1000, Math.max(35, Math.ceil(barsCount / 5) + 50)),
    M15: Math.min(1000, Math.max(35, Math.ceil(barsCount / 15) + 50)),
    H1: Math.min(1000, Math.max(35, Math.ceil(barsCount / 60) + 50))
  };
  const [m1Result, m5Result, m15Result, h1Result, specResult, quoteResult] = await Promise.all([
    bridge.candles("M1", barsCount), bridge.candles("M5", contextCounts.M5),
    bridge.candles("M15", contextCounts.M15), bridge.candles("H1", contextCounts.H1),
    bridge.symbolSpec(), bridge.quote()
  ]);
  for (const [name, result] of [["M1",m1Result],["M5",m5Result],["M15",m15Result],["H1",h1Result],["مواصفات الرمز",specResult],["السعر الحالي",quoteResult]]) {
    if (!result.ok) throw Object.assign(new Error("فشل جلب " + name + " من جسر MT5: " + result.message), { status: 503, code: "HISTORICAL_DATA_UNAVAILABLE" });
  }
  const normalized = {};
  for (const [tf, result] of [["M1",m1Result],["M5",m5Result],["M15",m15Result],["H1",h1Result]]) {
    const raw = result.value.candles;
    const clean = normalizeClosedCandles(raw, tf, tf === "M1" ? 100 : 35);
    if (!clean.ok) throw Object.assign(new Error("بيانات " + tf + " التاريخية غير صالحة: " + clean.error), { status: 503, code: "INVALID_HISTORICAL_DATA" });
    normalized[tf] = clean.value;
  }
  const bars = normalized.M1;
  if (bars.length < 100) throw Object.assign(new Error("الجسر لم يرجع 100 شمعة M1 مغلقة على الأقل."), { status: 503, code: "INSUFFICIENT_HISTORY" });
  const { tickSize, tickValuePerLot } = specResult.value;
  if (!finite(tickSize) || tickSize <= 0 || !finite(tickValuePerLot) || tickValuePerLot <= 0) {
    throw Object.assign(new Error("مواصفات tickSize/tickValue من MT5 غير صالحة؛ لا يمكن حساب الربح النقدي بدقة."), { status: 503, code: "INVALID_SYMBOL_SPEC" });
  }
  const candidates = [];
  const warmup = Math.max(35, 21);
  for (let i = warmup - 1; i < bars.length - 1; i++) {
    const current = bars[i];
    const asOfMs = Date.parse(current.closeTime);
    const candles = {
      M1: bars.slice(0, i + 1),
      M5: closedBefore(normalized.M5, asOfMs),
      M15: closedBefore(normalized.M15, asOfMs),
      H1: closedBefore(normalized.H1, asOfMs)
    };
    const analysis = analyzeClosedMarket({
      symbol: "XAUUSD", candles, now: new Date(asOfMs + 1).toISOString(),
      maxM1AgeMs: 120000, minimumM1Bars: 35
    });
    const evidence = analysis.status === "READY" ? analysis.evidence[0] : undefined;
    if (evidence) candidates.push({ index: i, evidence });
  }
  const trades = [];
  const aiErrors = [];
  let aiCalls = 0, aiRejected = 0, skippedOverlap = 0, lastExitIndex = -1;
  for (const candidate of candidates) {
    if (candidate.index <= lastExitIndex) { skippedOverlap++; continue; }
    if (aiCalls >= maxAiCalls) break;
    aiCalls++;
    let assessment;
    try {
      assessment = await aiProvider.assess({ symbol: "XAUUSD", evidence: [candidate.evidence], now: candidate.evidence.createdAt });
    } catch (error) {
      aiErrors.push({ signalTime: candidate.evidence.createdAt, code: typeof error?.code === "string" ? error.code : "AI_ERROR" });
      continue;
    }
    const decision = coordinateTechnicalAndAI([candidate.evidence], assessment);
    if (decision.outcome !== candidate.evidence.direction) { aiRejected++; continue; }
    const trade = simulateTrade({ ...candidate, aiOutcome: assessment.outcome }, bars, spreadPrice, lots, tickSize, tickValuePerLot, commissionPerLot);
    if (!trade) continue;
    lastExitIndex = trade._exitIndex;
    delete trade._exitIndex;
    trades.push(trade);
  }
  const skippedByLimit = Math.max(0, candidates.length - aiCalls - skippedOverlap);
  let netPnl = 0, grossProfit = 0, grossLoss = 0, peak = 0, maxDrawdown = 0;
  const equityCurve = [];
  for (const trade of trades) {
    netPnl += trade.netPnl;
    if (trade.netPnl > 0) grossProfit += trade.netPnl;
    if (trade.netPnl < 0) grossLoss += trade.netPnl;
    peak = Math.max(peak, netPnl);
    maxDrawdown = Math.max(maxDrawdown, peak - netPnl);
    equityCurve.push({ time: trade.exitTime, equity: round(netPnl, 2) });
  }
  const wins = trades.filter(trade => trade.netPnl > 0).length;
  const losses = trades.filter(trade => trade.netPnl < 0).length;
  return {
    ok: true, mode: "HISTORICAL_AI_BACKTEST", symbol: "XAUUSD",
    ai: { providerId: aiProviderId, modelId: aiModelId },
    data: {
      timeframe: "M1", requestedBars: barsCount, receivedBars: bars.length,
      startTime: bars[0].openTime, endTime: bars[bars.length - 1].closeTime,
      contextBars: { M5: normalized.M5.length, M15: normalized.M15.length, H1: normalized.H1.length },
      source: "MT5_BRIDGE_CLOSED_CANDLES"
    },
    assumptions: {
      lots, spreadPrice, spreadSource: request.spreadSource || "USER_INPUT",
      commissionPerLotRoundTurn: commissionPerLot, tickSize, tickValuePerLot,
      entry: "next M1 candle open; buy entry includes configured spread",
      sameCandleStopAndTarget: "stop loss first (conservative)",
      dataEnd: "remaining positions marked to last close",
      noLookahead: true, liveOrdersSent: false
    },
    metrics: {
      candidateSignals: candidates.length, aiCalls, aiRejected, aiErrors: aiErrors.length,
      aiCallsSkippedByLimit: skippedByLimit, overlappingSignalsSkipped: skippedOverlap,
      trades: trades.length, wins, losses, breakeven: trades.length - wins - losses,
      winRatePercent: trades.length ? round(wins / trades.length * 100, 2) : 0,
      grossProfit: round(grossProfit, 2), grossLoss: round(grossLoss, 2),
      netPnl: round(netPnl, 2), maxDrawdown: round(maxDrawdown, 2),
      profitFactor: grossLoss < 0 ? round(grossProfit / Math.abs(grossLoss), 3) : null,
      expectancyPerTrade: trades.length ? round(netPnl / trades.length, 2) : 0
    },
    equityCurve, trades: trades.slice(-100), aiErrorDetails: aiErrors.slice(0, 20)
  };
}
