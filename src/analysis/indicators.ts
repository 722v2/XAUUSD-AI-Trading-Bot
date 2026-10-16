export interface MacdValue {
  readonly macd: number;
  readonly signal: number;
  readonly histogram: number;
}

function assertSeries(values: readonly number[]): void {
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Indicator input contains non-finite values");
}
export function ema(values: readonly number[], period: number): readonly (number | null)[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("EMA period must be a positive integer");
  assertSeries(values);
  const result: (number | null)[] = Array(values.length).fill(null);
  if (values.length < period) return result;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    current = values[i]! * alpha + current * (1 - alpha);
    result[i] = current;
  }
  return result;
}
export function rsi(values: readonly number[], period = 14): readonly (number | null)[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("RSI period must be a positive integer");
  assertSeries(values);
  const result: (number | null)[] = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i]! - values[i - 1]!;
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  const calc = () => avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  result[period] = calc();
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
    result[i] = calc();
  }
  return result;
}
export function macd(values: readonly number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): readonly (MacdValue | null)[] {
  if (fastPeriod >= slowPeriod) throw new Error("MACD fast period must be less than slow period");
  const fast = ema(values, fastPeriod), slow = ema(values, slowPeriod);
  const raw: (number | null)[] = values.map((_, i) => fast[i] === null || slow[i] === null ? null : fast[i]! - slow[i]!);
  const firstValid = raw.findIndex((value) => value !== null);
  const compressed = raw.slice(firstValid).filter((value): value is number => value !== null);
  const signalValues = ema(compressed, signalPeriod);
  const result: (MacdValue | null)[] = Array(values.length).fill(null);
  for (let j = 0; j < compressed.length; j += 1) {
    const index = firstValid + j, signal = signalValues[j];
    if (signal !== null && signal !== undefined) result[index] = { macd: compressed[j]!, signal, histogram: compressed[j]! - signal };
  }
  return result;
}
export function atr(high: readonly number[], low: readonly number[], close: readonly number[], period = 14): readonly (number | null)[] {
  if (high.length !== low.length || low.length !== close.length) throw new Error("ATR series lengths must match");
  if (!Number.isInteger(period) || period < 1) throw new Error("ATR period must be a positive integer");
  assertSeries(high); assertSeries(low); assertSeries(close);
  const tr: number[] = [];
  for (let i = 0; i < high.length; i += 1) {
    if (high[i]! < low[i]!) throw new Error("ATR high cannot be below low");
    tr.push(i === 0 ? high[i]! - low[i]! : Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!)));
  }
  const result: (number | null)[] = Array(high.length).fill(null);
  if (tr.length < period) return result;
  let current = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  for (let i = period; i < tr.length; i += 1) {
    current = (current * (period - 1) + tr[i]!) / period;
    result[i] = current;
  }
  return result;
}
