import type { Candle, Direction, TechnicalEvidence, Timeframe } from "../domain/types.js";
import { atr, ema, macd, rsi } from "./indicators.js";

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
    readonly higherTimeframeContext: Readonly<Record<"M5" | "M15" | "H1", TrendContext>>;
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
  const e9 = ema9[i], e21 = ema21[i], rv = rsis[i], mv = macds[i], av = atrs[i];
  if (e9 == null || e21 == null || rv == null || mv == null || av == null || av <= 0) {
    return { status: "NO_ANALYSIS", reason: "INSUFFICIENT_HISTORY", evaluatedAt: input.now, latestClosedBarTime: latest.closeTime, evidence: EMPTY };
  }
  const higherTimeframeContext = {
    M5: trendContext(input.candles.M5, "M5", nowMs),
    M15: trendContext(input.candles.M15, "M15", nowMs),
    H1: trendContext(input.candles.H1, "H1", nowMs)
  };
  const metrics = { ema9: e9, ema21: e21, rsi14: rv, macd: mv.macd, macdSignal: mv.signal, macdHistogram: mv.histogram, atr14: av, higherTimeframeContext };
  const up = e9 > e21 && mv.histogram > 0 && rv >= 50 && rv < 75;
  const down = e9 < e21 && mv.histogram < 0 && rv <= 50 && rv > 25;
  if (!up && !down) return { status: "WAIT", reason: "NO_SETUP", evaluatedAt: input.now, latestClosedBarTime: latest.closeTime, metrics, evidence: EMPTY };
  const direction: Direction = up ? "BUY" : "SELL";
  const entryPrice = latest.close;
  const stopLoss = direction === "BUY" ? entryPrice - 1.5 * av : entryPrice + 1.5 * av;
  const takeProfit = direction === "BUY" ? entryPrice + 2 * av : entryPrice - 2 * av;
  const contextCodes = Object.entries(higherTimeframeContext).map(([timeframe, trend]) => `${timeframe}_${trend}`);
  const evidence: TechnicalEvidence = {
    strategyId: "M1_EMA_MACD_RSI_ATR_V1",
    direction,
    evidenceCodes: ["CLOSED_M1_ONLY", up ? "EMA9_ABOVE_EMA21" : "EMA9_BELOW_EMA21", up ? "MACD_HISTOGRAM_POSITIVE" : "MACD_HISTOGRAM_NEGATIVE", up ? "RSI_BULLISH_RANGE" : "RSI_BEARISH_RANGE", "ATR_STRUCTURAL_DISTANCE_V1", ...contextCodes],
    entryPrice, stopLoss, takeProfit,
    createdAt: input.now as TechnicalEvidence["createdAt"],
    expiresAt: new Date(nowMs + 60_000).toISOString() as TechnicalEvidence["expiresAt"]
  };
  return { status: "READY", reason: "SETUP_FOUND", evaluatedAt: input.now, latestClosedBarTime: latest.closeTime, metrics, evidence: [evidence] };
}
