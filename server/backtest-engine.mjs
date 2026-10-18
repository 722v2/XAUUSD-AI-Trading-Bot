function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function round(value, digits = 2) { const scale = 10 ** digits; return Math.round((value + Number.EPSILON) * scale) / scale; }
function closedBefore(candles, timeMs) {
  let low=0, high=candles.length;
  while(low<high) {
    const mid=(low+high)>>>1;
    if(Date.parse(candles[mid].closeTime)<=timeMs) low=mid+1;
    else high=mid;
  }
  return candles.slice(Math.max(0,low-1000),low);
}
function sessionSpread(baseSpread, timeValue) {
  const hour = new Date(timeValue).getUTCHours();
  // Approximate wider spreads around rollover and thinner liquidity; this is not broker tick history.
  const multiplier = hour >= 21 || hour < 1 ? 2.0 : hour >= 12 && hour < 16 ? 0.85 : hour >= 6 && hour < 20 ? 1.0 : 1.25;
  return baseSpread * multiplier;
}
function simulateTrade(candidate, bars, baseSpreadPrice, slippagePrice, lots, tickSize, tickValuePerLot, commissionPerLot) {
  const entryIndex = candidate.index + 1;
  if (entryIndex >= bars.length) return null;
  const signal = candidate.evidence;
  const stopDistance = signal.direction === "BUY" ? signal.entryPrice - signal.stopLoss : signal.stopLoss - signal.entryPrice;
  const targetDistance = signal.direction === "BUY" ? signal.takeProfit - signal.entryPrice : signal.entryPrice - signal.takeProfit;
  if (!(stopDistance > 0 && targetDistance > 0)) return null;
  const entryBar = bars[entryIndex];
  const entrySpread = sessionSpread(baseSpreadPrice, entryBar.openTime);
  const entryPrice = signal.direction === "BUY" ? entryBar.open + entrySpread + slippagePrice : entryBar.open - slippagePrice;
  let stopLoss = signal.direction === "BUY" ? entryPrice - stopDistance - entrySpread : entryPrice + stopDistance + entrySpread;
  const takeProfit = signal.direction === "BUY" ? entryPrice + targetDistance : entryPrice - targetDistance;
  const riskDistance = Math.abs(entryPrice - stopLoss);
  const breakEvenTrigger = riskDistance * 1.2;
  const trailingTrigger = riskDistance * 1.5;
  const trailingDistance = stopDistance * 0.8; // Live manager uses 1.2 ATR; signal stop is 1.5 ATR.
  let breakEvenMoved = false, trailingStarted = false;
  let exitPrice = null, exitReason = "DATA_END", exitIndex = bars.length - 1;
  for (let i = entryIndex; i < bars.length; i++) {
    const bar = bars[i];
    const spread = sessionSpread(baseSpreadPrice, bar.openTime);
    const high = signal.direction === "SELL" ? bar.high + spread : bar.high;
    const low = signal.direction === "SELL" ? bar.low + spread : bar.low;
    const favorable = signal.direction === "BUY" ? high - entryPrice : entryPrice - low;
    if (!breakEvenMoved && favorable >= breakEvenTrigger) {
      stopLoss = signal.direction === "BUY" ? Math.max(stopLoss, entryPrice + slippagePrice) : Math.min(stopLoss, entryPrice - slippagePrice);
      breakEvenMoved = true;
    }
    if (favorable >= trailingTrigger) {
      trailingStarted = true;
      const trail = signal.direction === "BUY" ? bar.close - trailingDistance : bar.close + trailingDistance;
      stopLoss = signal.direction === "BUY" ? Math.max(stopLoss, trail) : Math.min(stopLoss, trail);
    }
    const stopHit = signal.direction === "BUY" ? low <= stopLoss : high >= stopLoss;
    const targetHit = signal.direction === "BUY" ? high >= takeProfit : low <= takeProfit;
    if (stopHit) { exitPrice = stopLoss; exitReason = targetHit ? "SL_AND_TP_SAME_BAR_SL_FIRST" : trailingStarted ? "TRAILING_STOP" : breakEvenMoved ? "BREAK_EVEN_STOP" : "STOP_LOSS"; exitIndex = i; break; }
    if (targetHit) { exitPrice = takeProfit; exitReason = "TAKE_PROFIT"; exitIndex = i; break; }
  }
  if (exitPrice === null) {
    const last = bars[bars.length - 1];
    const spread = sessionSpread(baseSpreadPrice, last.closeTime);
    exitPrice = signal.direction === "BUY" ? last.close : last.close + spread;
  }
  exitPrice += signal.direction === "BUY" ? -slippagePrice : slippagePrice;
  const signedMove = signal.direction === "BUY" ? exitPrice - entryPrice : entryPrice - exitPrice;
  const grossPnl = signedMove / tickSize * tickValuePerLot * lots;
  const commission = commissionPerLot * lots;
  const netPnl = grossPnl - commission;
  return {
    signalTime: signal.createdAt, entryTime: entryBar.openTime, exitTime: bars[exitIndex].closeTime,
    direction: signal.direction, strategyId: signal.strategyId, aiOutcome: candidate.aiOutcome ?? "NOT_USED",
    entryPrice: round(entryPrice, 3), stopLoss: round(stopLoss, 3), takeProfit: round(takeProfit, 3),
    exitPrice: round(exitPrice, 3), exitReason, lots: round(lots, 4),
    grossPnl: round(grossPnl, 2), commission: round(commission, 2), netPnl: round(netPnl, 2),
    rMultiple: round(netPnl / (((riskDistance + 2 * slippagePrice) / tickSize * tickValuePerLot * lots + commission) || 1), 3),
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
  const useAI = request.useAI === true;
  if (useAI && !aiProvider) throw Object.assign(new Error("اختر نموذج AI مضبوطًا على الخادم أولًا."), { status: 409, code: "AI_NOT_CONFIGURED" });
  const barsCount = request.barsCount;
  const lots = request.lots;
  const spreadPrice = request.spreadPrice;
  const slippagePrice = request.slippagePrice ?? 0;
  const commissionPerLot = request.commissionPerLot;
  const maxAiCalls = request.maxAiCalls;
  if (!Number.isInteger(barsCount) || barsCount < 100 || barsCount > 50000 ||
      !finite(lots) || lots <= 0 || lots > 100 ||
      !finite(spreadPrice) || spreadPrice < 0 || spreadPrice > 100 ||
      !finite(slippagePrice) || slippagePrice < 0 || slippagePrice > 100 ||
      !finite(commissionPerLot) || commissionPerLot < 0 || commissionPerLot > 10000 ||
      !Number.isInteger(maxAiCalls) || maxAiCalls < 1 || maxAiCalls > 5000) {
    throw Object.assign(new Error("إعدادات الاختبار غير صالحة. الشموع 100–50000، والانزلاق غير سالب، وعدد تقييمات AI من 1 إلى 5000."), { status: 400, code: "INVALID_BACKTEST_CONFIG" });
  }
  const health = await bridge.health();
  if (!health.ok || health.value.state !== "CONNECTED" || health.value.environment !== "DEMO") {
    throw Object.assign(new Error("يجب اتصال جسر MT5 بحساب Demo قبل سحب البيانات التاريخية."), { status: 409, code: "MT5_DEMO_NOT_READY" });
  }
  const contextCounts = {
    M5: Math.min(50000, Math.max(35, Math.ceil(barsCount / 5) + 50)),
    M15: Math.min(50000, Math.max(35, Math.ceil(barsCount / 15) + 50)),
    H1: Math.min(50000, Math.max(35, Math.ceil(barsCount / 60) + 50))
  };
  const [m1Result, m5Result, m15Result, h1Result, specResult] = await Promise.all([
    bridge.candles("M1", barsCount), bridge.candles("M5", contextCounts.M5),
    bridge.candles("M15", contextCounts.M15), bridge.candles("H1", contextCounts.H1),
    bridge.symbolSpec()
  ]);
  for (const [name, result] of [["M1",m1Result],["M5",m5Result],["M15",m15Result],["H1",h1Result],["مواصفات الرمز",specResult]]) {
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
  const { tickSize, tickValuePerLot, volumeMin, volumeMax, volumeStep } = specResult.value;
  if (!finite(tickSize) || tickSize <= 0 || !finite(tickValuePerLot) || tickValuePerLot <= 0 ||
      !finite(volumeMin) || volumeMin <= 0 || !finite(volumeMax) || volumeMax < volumeMin ||
      !finite(volumeStep) || volumeStep <= 0) {
    throw Object.assign(new Error("مواصفات tick/حجم العقد من MT5 غير صالحة؛ لا يمكن حساب النتيجة النقدية بدقة."), { status: 503, code: "INVALID_SYMBOL_SPEC" });
  }
  const volumeSteps = lots / volumeStep;
  if (lots < volumeMin || lots > volumeMax || Math.abs(volumeSteps - Math.round(volumeSteps)) > 1e-7) {
    throw Object.assign(new Error("حجم Lot لا يطابق الحد الأدنى أو الأقصى أو خطوة الحجم لدى وسيط MT5."), { status: 400, code: "INVALID_BACKTEST_VOLUME" });
  }
  const candidates = [];
  const warmup = Math.max(35, 21);
  for (let i = warmup - 1; i < bars.length - 1; i++) {
    const current = bars[i];
    const asOfMs = Date.parse(current.closeTime);
    const candles = {
      M1: bars.slice(Math.max(0, i + 1 - 500), i + 1),
      M5: closedBefore(normalized.M5, asOfMs).slice(-1000),
      M15: closedBefore(normalized.M15, asOfMs).slice(-1000),
      H1: closedBefore(normalized.H1, asOfMs).slice(-1000)
    };
    const analysis = analyzeClosedMarket({
      symbol: "XAUUSD", candles, now: new Date(asOfMs + 1).toISOString(),
      maxM1AgeMs: 20000, minimumM1Bars: 35
    });
    const evidence = analysis.status === "READY" ? analysis.evidence[0] : undefined;
    if (evidence) candidates.push({ index: i, evidence });
  }
  const trades = [];
  const aiErrors = [];
  let aiCalls = 0, aiRejected = 0, skippedOverlap = 0, lastExitIndex = -1;
  for (const candidate of candidates) {
    if (candidate.index <= lastExitIndex) { skippedOverlap++; continue; }
    let aiOutcome = "NOT_USED";
    if (useAI) {
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
      aiOutcome = assessment.outcome;
    }
    const trade = simulateTrade({ ...candidate, aiOutcome }, bars, spreadPrice, slippagePrice, lots, tickSize, tickValuePerLot, commissionPerLot);
    if (!trade) continue;
    lastExitIndex = trade._exitIndex;
    delete trade._exitIndex;
    trade.sampleSegment = candidate.index < bars.length * 0.7 ? "IN_SAMPLE" : "OUT_OF_SAMPLE";
    trades.push(trade);
  }
  const skippedByLimit = useAI ? Math.max(0, candidates.length - aiCalls - skippedOverlap) : 0;
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
  const summarizeTrades=items=>{
    const profit=items.filter(trade=>trade.netPnl>0).reduce((sum,trade)=>sum+trade.netPnl,0);
    const loss=items.filter(trade=>trade.netPnl<0).reduce((sum,trade)=>sum+trade.netPnl,0);
    return {trades:items.length,wins:items.filter(trade=>trade.netPnl>0).length,losses:items.filter(trade=>trade.netPnl<0).length,
      winRatePercent:items.length?round(items.filter(trade=>trade.netPnl>0).length/items.length*100,2):0,
      netPnl:round(items.reduce((sum,trade)=>sum+trade.netPnl,0),2),profitFactor:loss<0?round(profit/Math.abs(loss),3):null,
      expectancyPerTrade:items.length?round(items.reduce((sum,trade)=>sum+trade.netPnl,0)/items.length,2):0};
  };
  const strategyBreakdown=Object.fromEntries([...new Set(trades.map(trade=>trade.strategyId))].map(id=>[id,summarizeTrades(trades.filter(trade=>trade.strategyId===id))]));
  const sampleBreakdown={inSample:summarizeTrades(trades.filter(trade=>trade.sampleSegment==="IN_SAMPLE")),outOfSample:summarizeTrades(trades.filter(trade=>trade.sampleSegment==="OUT_OF_SAMPLE"))};
  return {
    ok: true, mode: useAI ? "HISTORICAL_AI_BACKTEST" : "HISTORICAL_TECHNICAL_BACKTEST", symbol: "XAUUSD",
    ai: useAI ? { providerId: aiProviderId, modelId: aiModelId } : { used: false },
    data: {
      timeframe: "M1", requestedBars: barsCount, receivedBars: bars.length,
      startTime: bars[0].openTime, endTime: bars[bars.length - 1].closeTime,
      contextBars: { M5: normalized.M5.length, M15: normalized.M15.length, H1: normalized.H1.length },
      source: "MT5_BRIDGE_CLOSED_CANDLES"
    },
    assumptions: {
      lots, spreadPrice, slippagePrice, spreadSource: request.spreadSource || "USER_INPUT", spreadModel: "UTC_SESSION_APPROXIMATION_NOT_TICK_HISTORY",
      breakEvenAtR: 1.2, trailingStartsAtR: 1.5, trailingDistanceApproximation: "0.8x initial stop distance",
      commissionPerLotRoundTurn: commissionPerLot, tickSize, tickValuePerLot,
      entry: "next M1 candle open; buy entry includes configured spread",
      sameCandleStopAndTarget: "stop loss first (conservative)",
      dataEnd: "remaining positions marked to last close",
      chronologicalSplit: "70% in-sample / 30% out-of-sample by signal time; no parameter fitting performed",
      noLookahead: true, liveOrdersSent: false
    },
    metrics: {
      candidateSignals: candidates.length, aiUsed: useAI, aiCalls, aiRejected, aiErrors: aiErrors.length,
      aiCallsSkippedByLimit: skippedByLimit, overlappingSignalsSkipped: skippedOverlap,
      trades: trades.length, wins, losses, breakeven: trades.length - wins - losses,
      winRatePercent: trades.length ? round(wins / trades.length * 100, 2) : 0,
      grossProfit: round(grossProfit, 2), grossLoss: round(grossLoss, 2),
      netPnl: round(netPnl, 2), maxDrawdown: round(maxDrawdown, 2),
      profitFactor: grossLoss < 0 ? round(grossProfit / Math.abs(grossLoss), 3) : null,
      expectancyPerTrade: trades.length ? round(netPnl / trades.length, 2) : 0,
      strategyBreakdown, sampleBreakdown
    },
    equityCurve, trades: trades.slice(-100), aiErrorDetails: aiErrors.slice(0, 20)
  };
}
