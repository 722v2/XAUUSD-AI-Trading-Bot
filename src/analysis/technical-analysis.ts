import type { Candle, Direction, TechnicalEvidence, Timeframe } from "../domain/types.js";
import { atr, ema, macd, rsi } from "./indicators.js";
import { selectAdaptiveStrategy, type MarketRegime } from "./strategy-selector.js";

export type TechnicalAnalysisStatus = "READY" | "WAIT" | "NO_ANALYSIS";
export type TechnicalAnalysisReason = "INSUFFICIENT_HISTORY" | "INVALID_HISTORY" | "STALE_DATA" | "NO_SETUP" | "CONFLICTING_EVIDENCE" | "SETUP_FOUND";
export type TrendContext = "BULLISH" | "BEARISH" | "NEUTRAL" | "INSUFFICIENT";
export interface TechnicalAnalysisResult {
  readonly status: TechnicalAnalysisStatus;
  readonly reason: TechnicalAnalysisReason;
  readonly evaluatedAt: string;
  readonly latestClosedBarTime?: string;
  readonly metrics?: {
    readonly ema9: number;
    readonly ema21: number;
    readonly rsi14: number;
    readonly macd: number;
    readonly macdSignal: number;
    readonly macdHistogram: number;
    readonly atr14: number;
    readonly marketRegime: MarketRegime;
    readonly trendStrength: number;
    readonly higherTimeframeContext: Readonly<Record<"M5" | "M15" | "H1", TrendContext>>;
    readonly triggerChecks: Readonly<{
      trendUp: boolean; trendDown: boolean;
      continuationBuy: boolean; continuationSell: boolean;
      pullbackBuy: boolean; pullbackSell: boolean;
      breakoutBuy: boolean; breakoutSell: boolean;
      currentBullish: boolean; currentBearish: boolean;
      closeBreaksPreviousHigh: boolean; closeBreaksPreviousLow: boolean;
      closeBreaksPriorRangeHigh: boolean; closeBreaksPriorRangeLow: boolean;
      macdPositive: boolean; macdNegative: boolean;
      bullishMomentum: boolean; bearishMomentum: boolean;
      rsiInBuyRange: boolean; rsiInSellRange: boolean;
    }>;
  };
  readonly evidence: readonly TechnicalEvidence[];
}
export interface TechnicalAnalysisInput {
  readonly symbol: "XAUUSD";
  readonly candles: Readonly<Record<Timeframe, readonly Candle[]>>;
  readonly now: string;
  readonly maxM1AgeMs?: number;
  readonly minimumM1Bars?: number;
}
const EMPTY: readonly TechnicalEvidence[] = Object.freeze([]);

function trendContext(bars: readonly Candle[], timeframe: "M5" | "M15" | "H1", nowMs: number): TrendContext {
  const closed = bars.filter(bar => bar.isClosed && bar.timeframe === timeframe && Date.parse(bar.closeTime) <= nowMs);
  if (closed.length < 21) return "INSUFFICIENT";
  const values = closed.map(bar => bar.close);
  const fast = ema(values,9), slow = ema(values,21);
  const f = fast[fast.length-1], s = slow[slow.length-1];
  if (f == null || s == null) return "INSUFFICIENT";
  if (f > s) return "BULLISH";
  if (f < s) return "BEARISH";
  return "NEUTRAL";
}

export function analyzeClosedMarket(input: TechnicalAnalysisInput): TechnicalAnalysisResult {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) return { status: "NO_ANALYSIS", reason: "INVALID_HISTORY", evaluatedAt: input.now, evidence: EMPTY };
  const m1 = input.candles.M1;
  const minimum = input.minimumM1Bars ?? 35;
  if (m1.length < minimum) return { status: "NO_ANALYSIS", reason: "INSUFFICIENT_HISTORY", evaluatedAt: input.now, evidence: EMPTY };
  if (m1.some((bar) => !bar.isClosed || bar.symbol !== "XAUUSD" || bar.timeframe !== "M1")) return { status: "NO_ANALYSIS", reason: "INVALID_HISTORY", evaluatedAt: input.now, evidence: EMPTY };
  for (let i = 1; i < m1.length; i += 1) {
    if (Date.parse(m1[i]!.openTime) <= Date.parse(m1[i - 1]!.openTime)) return { status: "NO_ANALYSIS", reason: "INVALID_HISTORY", evaluatedAt: input.now, evidence: EMPTY };
  }
  const latest = m1[m1.length - 1]!;
  if (Date.parse(latest.closeTime) > nowMs || nowMs - Date.parse(latest.closeTime) > (input.maxM1AgeMs ?? 120_000)) {
    return { status: "NO_ANALYSIS", reason: "STALE_DATA", evaluatedAt: input.now, latestClosedBarTime: latest.closeTime, evidence: EMPTY };
  }
  const closes = m1.map((bar) => bar.close);
  const ema9 = ema(closes, 9), ema21 = ema(closes, 21), rsis = rsi(closes, 14);
  const macds = macd(closes), atrs = atr(m1.map((bar) => bar.high), m1.map((bar) => bar.low), closes);
  const i = m1.length - 1;
  const e9 = ema9[i], e21 = ema21[i], rv = rsis[i], mv = macds[i], previousMv = macds[i-1], av = atrs[i];
  if (e9 == null || e21 == null || rv == null || mv == null || av == null || av <= 0) {
    return { status: "NO_ANALYSIS", reason: "INSUFFICIENT_HISTORY", evaluatedAt: input.now, latestClosedBarTime: latest.closeTime, evidence: EMPTY };
  }
  const higherTimeframeContext = {
    M5: trendContext(input.candles.M5, "M5", nowMs),
    M15: trendContext(input.candles.M15, "M15", nowMs),
    H1: trendContext(input.candles.H1, "H1", nowMs)
  };
  const higherTimeframeBias:"BULLISH"|"BEARISH"|"MIXED" =
    Object.values(higherTimeframeContext).every(value=>value==="BULLISH") ? "BULLISH" :
    Object.values(higherTimeframeContext).every(value=>value==="BEARISH") ? "BEARISH" : "MIXED";
  const trendStrength=Math.abs(e9-e21)/av;
  const bullishMomentum=mv.histogram>0 || (mv.histogram<=0 && previousMv!=null && mv.histogram>previousMv.histogram);
  const bearishMomentum=mv.histogram<0 || (mv.histogram>=0 && previousMv!=null && mv.histogram<previousMv.histogram);
  const previousEma9=ema9[i-1], ema21FiveBarsAgo=ema21[i-5];
  const previous=m1[i-1]!;
  const priorRange=m1.slice(Math.max(0,i-20),i);
  if (previousEma9==null || ema21FiveBarsAgo==null || priorRange.length<20) {
    return { status:"NO_ANALYSIS",reason:"INSUFFICIENT_HISTORY",evaluatedAt:input.now,latestClosedBarTime:latest.closeTime,evidence:EMPTY };
  }
  const priorRangeHigh=Math.max(...priorRange.map(bar=>bar.high));
  const priorRangeLow=Math.min(...priorRange.map(bar=>bar.low));
  const selection=selectAdaptiveStrategy({
    trendStrength,ema9:e9,ema21:e21,ema21FiveBarsAgo,previousEma9,previousClose:previous.close,
    previousHigh:previous.high,previousLow:previous.low,currentOpen:latest.open,currentClose:latest.close,
    priorRangeHigh,priorRangeLow,rsi14:rv,macdHistogram:mv.histogram,...(previousMv?{previousMacdHistogram:previousMv.histogram}:{}),
    higherTimeframeBias,atr14:av
  });
  const trendUp=e9>e21 && e21>ema21FiveBarsAgo;
  const trendDown=e9<e21 && e21<ema21FiveBarsAgo;
  const currentBullish=latest.close>latest.open;
  const currentBearish=latest.close<latest.open;
  const triggerChecks={
    trendUp,trendDown,currentBullish,currentBearish,
    continuationBuy:latest.close>previous.high&&currentBullish&&e9>e21&&bullishMomentum&&rv>=50&&rv<75,
    continuationSell:latest.close<previous.low&&currentBearish&&e9<e21&&bearishMomentum&&rv<=50&&rv>25,
    pullbackBuy:trendUp&&previous.close<=previousEma9&&latest.close>e9&&currentBullish&&bullishMomentum&&rv>=45&&rv<75,
    pullbackSell:trendDown&&previous.close>=previousEma9&&latest.close<e9&&currentBearish&&bearishMomentum&&rv<=55&&rv>25,
    breakoutBuy:latest.close>priorRangeHigh+0.1*av&&currentBullish&&mv.histogram>0&&rv>=55&&rv<80,
    breakoutSell:latest.close<priorRangeLow-0.1*av&&currentBearish&&mv.histogram<0&&rv<=45&&rv>20,
    momentumRecoveryBuy:higherTimeframeBias==="BULLISH"&&trendStrength<0.25&&latest.close>previous.high&&currentBullish&&bullishMomentum&&rv>=45&&rv<=70&&e9>=e21-0.2*av,
    momentumRecoverySell:higherTimeframeBias==="BEARISH"&&trendStrength<0.25&&latest.close<previous.low&&currentBearish&&bearishMomentum&&rv>=30&&rv<=55&&e9<=e21+0.2*av,
    closeBreaksPreviousHigh:latest.close>previous.high,
    closeBreaksPreviousLow:latest.close<previous.low,
    closeBreaksPriorRangeHigh:latest.close>priorRangeHigh+0.1*av,
    closeBreaksPriorRangeLow:latest.close<priorRangeLow-0.1*av,
    macdPositive:mv.histogram>0,macdNegative:mv.histogram<0,bullishMomentum,bearishMomentum,
    rsiInBuyRange:rv>=45&&rv<80,rsiInSellRange:rv<=55&&rv>20
  };
  const metrics = { ema9:e9,ema21:e21,rsi14:rv,macd:mv.macd,macdSignal:mv.signal,macdHistogram:mv.histogram,atr14:av,marketRegime:selection?.regime ?? (trendStrength>=0.25?"TRENDING":"RANGING") as MarketRegime,trendStrength,higherTimeframeContext,triggerChecks };
  if (!selection) return { status:"WAIT",reason:"NO_SETUP",evaluatedAt:input.now,latestClosedBarTime:latest.closeTime,metrics,evidence:EMPTY };
  const direction: Direction = selection.direction;
  const m15Context=higherTimeframeContext.M15, h1Context=higherTimeframeContext.H1;
  const higherTimeframeOpposes=(direction==="BUY" && (m15Context==="BEARISH" || h1Context==="BEARISH")) ||
    (direction==="SELL" && (m15Context==="BULLISH" || h1Context==="BULLISH"));
  if (higherTimeframeOpposes) {
    return {status:"WAIT",reason:"CONFLICTING_EVIDENCE",evaluatedAt:input.now,latestClosedBarTime:latest.closeTime,metrics,evidence:EMPTY};
  }
  const entryPrice = latest.close;
  const stopLoss = direction === "BUY" ? entryPrice - 1.5 * av : entryPrice + 1.5 * av;
  const takeProfit = direction === "BUY" ? entryPrice + 3 * av : entryPrice - 3 * av;
  const contextCodes = Object.entries(higherTimeframeContext).map(([timeframe, trend]) => `${timeframe}_${trend}`);
  const evidence: TechnicalEvidence = {
    strategyId: selection.strategyId,
    direction,
    evidenceCodes: ["CLOSED_M1_ONLY",...selection.evidenceCodes,selection.strategyId==="M1_MOMENTUM_RECOVERY_V1"?"MACD_MOMENTUM_RECOVERING":direction==="BUY"?"MACD_HISTOGRAM_POSITIVE":"MACD_HISTOGRAM_NEGATIVE",direction==="BUY"?"RSI_BULLISH_RANGE":"RSI_BEARISH_RANGE","ATR_STRUCTURAL_DISTANCE_V1",...contextCodes],
    entryPrice, stopLoss, takeProfit,
    createdAt: input.now as TechnicalEvidence["createdAt"],
    expiresAt: new Date(nowMs + 60_000).toISOString() as TechnicalEvidence["expiresAt"]
  };
  return { status:"READY",reason:"SETUP_FOUND",evaluatedAt:input.now,latestClosedBarTime:latest.closeTime,metrics,evidence:[evidence] };
}
