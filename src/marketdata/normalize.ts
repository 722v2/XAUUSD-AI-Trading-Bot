import type { Candle, MarketQuote, Timeframe } from "../domain/types.js";

export type MarketDataError =
  | "INVALID_SYMBOL"
  | "INVALID_PRICE"
  | "CROSSED_QUOTE"
  | "INVALID_TIMESTAMP"
  | "INVALID_OHLC"
  | "BAR_NOT_CLOSED"
  | "OUT_OF_ORDER"
  | "DUPLICATE_BAR"
  | "INSUFFICIENT_HISTORY";

export type MarketDataResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MarketDataError; readonly index?: number };

export interface RawCandle {
  readonly symbol: string;
  readonly timeframe: string;
  readonly openTime: string | number;
  readonly closeTime: string | number;
  readonly open: unknown;
  readonly high: unknown;
  readonly low: unknown;
  readonly close: unknown;
  readonly tickVolume?: unknown;
  readonly isClosed: boolean;
}

function parseTime(value: string | number): string | null {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function validTimeframe(value: string): value is Timeframe {
  return value === "M1" || value === "M5" || value === "M15" || value === "H1";
}

export function normalizeQuote(raw: { readonly symbol: string; readonly bid: unknown; readonly ask: unknown; readonly tickTime: string | number; readonly receivedAt?: string | number }): MarketDataResult<MarketQuote> {
  if (raw.symbol.trim().toUpperCase() !== "XAUUSD") return { ok: false, error: "INVALID_SYMBOL" };
  if (!positiveNumber(raw.bid) || !positiveNumber(raw.ask)) return { ok: false, error: "INVALID_PRICE" };
  if ((raw.ask as number) < (raw.bid as number)) return { ok: false, error: "CROSSED_QUOTE" };
  const tickTime = parseTime(raw.tickTime);
  const receivedAt = parseTime(raw.receivedAt ?? Date.now());
  if (!tickTime || !receivedAt) return { ok: false, error: "INVALID_TIMESTAMP" };
  return { ok: true, value: { symbol: "XAUUSD", bid: raw.bid, ask: raw.ask, tickTime: tickTime as MarketQuote["tickTime"], receivedAt: receivedAt as MarketQuote["receivedAt"] } };
}

export function normalizeClosedCandles(raw: readonly RawCandle[], expectedTimeframe: Timeframe, minimumBars = 1): MarketDataResult<readonly Candle[]> {
  if (!Number.isInteger(minimumBars) || minimumBars < 1 || raw.length < minimumBars) return { ok: false, error: "INSUFFICIENT_HISTORY" };
  const normalized: Candle[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const bar = raw[i];
    if (!bar) return { ok: false, error: "INVALID_OHLC", index: i };
    if (bar.symbol.trim().toUpperCase() !== "XAUUSD" || !validTimeframe(bar.timeframe) || bar.timeframe !== expectedTimeframe) return { ok: false, error: "INVALID_SYMBOL", index: i };
    if (!bar.isClosed) return { ok: false, error: "BAR_NOT_CLOSED", index: i };
    const openTime = parseTime(bar.openTime);
    const closeTime = parseTime(bar.closeTime);
    if (!openTime || !closeTime || Date.parse(closeTime) <= Date.parse(openTime)) return { ok: false, error: "INVALID_TIMESTAMP", index: i };
    if (![bar.open, bar.high, bar.low, bar.close].every(positiveNumber)) return { ok: false, error: "INVALID_PRICE", index: i };
    const open = bar.open as number, high = bar.high as number, low = bar.low as number, close = bar.close as number;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return { ok: false, error: "INVALID_OHLC", index: i };
    const tickVolume = bar.tickVolume === undefined ? 0 : bar.tickVolume;
    if (typeof tickVolume !== "number" || !Number.isFinite(tickVolume) || tickVolume < 0) return { ok: false, error: "INVALID_OHLC", index: i };
    const key = openTime;
    if (seen.has(key)) return { ok: false, error: "DUPLICATE_BAR", index: i };
    if (normalized.length && Date.parse(openTime) <= Date.parse(normalized[normalized.length - 1]!.openTime)) return { ok: false, error: "OUT_OF_ORDER", index: i };
    seen.add(key);
    normalized.push({ symbol: "XAUUSD", timeframe: expectedTimeframe, openTime: openTime as Candle["openTime"], closeTime: closeTime as Candle["closeTime"], open, high, low, close, tickVolume, isClosed: true });
  }
  return { ok: true, value: normalized };
}
