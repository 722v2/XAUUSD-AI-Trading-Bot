import type { Direction } from "../domain/types.js";

export type MarketRegime = "TRENDING" | "RANGING";
export interface StrategySelectionInput {
  readonly trendStrength: number;
  readonly ema9: number;
  readonly ema21: number;
  readonly ema21FiveBarsAgo: number;
  readonly previousEma9: number;
  readonly previousClose: number;
  readonly currentOpen: number;
  readonly currentClose: number;
  readonly priorRangeHigh: number;
  readonly priorRangeLow: number;
  readonly rsi14: number;
  readonly macdHistogram: number;
  readonly atr14: number;
}
export interface StrategySelection {
  readonly strategyId: string;
  readonly direction: Direction;
  readonly regime: MarketRegime;
  readonly evidenceCodes: readonly string[];
}

/** Deterministic regime selection. All range levels exclude the current closed candle. */
export function selectAdaptiveStrategy(input: StrategySelectionInput): StrategySelection | null {
  const values=Object.values(input);
  if (values.some(value=>!Number.isFinite(value)) || input.atr14<=0 || input.priorRangeHigh<input.priorRangeLow) return null;
  const regime:MarketRegime=input.trendStrength>=0.25?"TRENDING":"RANGING";
  const trendUp=input.ema9>input.ema21 && input.ema21>input.ema21FiveBarsAgo;
  const trendDown=input.ema9<input.ema21 && input.ema21<input.ema21FiveBarsAgo;
  const bullishCandle=input.currentClose>input.currentOpen;
  const bearishCandle=input.currentClose<input.currentOpen;
  const continuationBuy=input.ema9>input.ema21 && input.macdHistogram>0 && input.rsi14>=50 && input.rsi14<75;
  const continuationSell=input.ema9<input.ema21 && input.macdHistogram<0 && input.rsi14<=50 && input.rsi14>25;
  const pullbackBuy=trendUp && input.previousClose<=input.previousEma9 && input.currentClose>input.ema9 && bullishCandle && input.macdHistogram>0 && input.rsi14>=45 && input.rsi14<75;
  const pullbackSell=trendDown && input.previousClose>=input.previousEma9 && input.currentClose<input.ema9 && bearishCandle && input.macdHistogram<0 && input.rsi14<=55 && input.rsi14>25;
  const breakoutBuy=input.currentClose>input.priorRangeHigh+0.1*input.atr14 && bullishCandle && input.macdHistogram>0 && input.rsi14>=55 && input.rsi14<80;
  const breakoutSell=input.currentClose<input.priorRangeLow-0.1*input.atr14 && bearishCandle && input.macdHistogram<0 && input.rsi14<=45 && input.rsi14>20;

  const candidates=regime==="TRENDING"
    ? [
        continuationBuy?{strategyId:"M1_TREND_CONTINUATION_V1",direction:"BUY" as const,codes:["TREND_CONTINUATION","EMA_TREND_CONFIRMED","MACD_MOMENTUM_CONFIRMED"]}:null,
        continuationSell?{strategyId:"M1_TREND_CONTINUATION_V1",direction:"SELL" as const,codes:["TREND_CONTINUATION","EMA_TREND_CONFIRMED","MACD_MOMENTUM_CONFIRMED"]}:null,
        pullbackBuy?{strategyId:"M1_PULLBACK_RECLAIM_V1",direction:"BUY" as const,codes:["PULLBACK_RECLAIM","TREND_SLOPE_CONFIRMED","EMA9_RECLAIM"]}:null,
        pullbackSell?{strategyId:"M1_PULLBACK_RECLAIM_V1",direction:"SELL" as const,codes:["PULLBACK_RECLAIM","TREND_SLOPE_CONFIRMED","EMA9_REJECTION"]}:null,
        breakoutBuy?{strategyId:"M1_RANGE_BREAKOUT_V1",direction:"BUY" as const,codes:["RANGE_BREAKOUT","CLOSED_BAR_RANGE_HIGH_BROKEN"]}:null,
        breakoutSell?{strategyId:"M1_RANGE_BREAKOUT_V1",direction:"SELL" as const,codes:["RANGE_BREAKOUT","CLOSED_BAR_RANGE_LOW_BROKEN"]}:null
      ]
    : [
        breakoutBuy?{strategyId:"M1_RANGE_BREAKOUT_V1",direction:"BUY" as const,codes:["RANGE_BREAKOUT","CLOSED_BAR_RANGE_HIGH_BROKEN"]}:null,
        breakoutSell?{strategyId:"M1_RANGE_BREAKOUT_V1",direction:"SELL" as const,codes:["RANGE_BREAKOUT","CLOSED_BAR_RANGE_LOW_BROKEN"]}:null,
        pullbackBuy?{strategyId:"M1_PULLBACK_RECLAIM_V1",direction:"BUY" as const,codes:["PULLBACK_RECLAIM","TREND_SLOPE_CONFIRMED","EMA9_RECLAIM"]}:null,
        pullbackSell?{strategyId:"M1_PULLBACK_RECLAIM_V1",direction:"SELL" as const,codes:["PULLBACK_RECLAIM","TREND_SLOPE_CONFIRMED","EMA9_REJECTION"]}:null,
        continuationBuy?{strategyId:"M1_TREND_CONTINUATION_V1",direction:"BUY" as const,codes:["TREND_CONTINUATION","EMA_TREND_CONFIRMED","MACD_MOMENTUM_CONFIRMED"]}:null,
        continuationSell?{strategyId:"M1_TREND_CONTINUATION_V1",direction:"SELL" as const,codes:["TREND_CONTINUATION","EMA_TREND_CONFIRMED","MACD_MOMENTUM_CONFIRMED"]}:null
      ];
  const selected=candidates.find(candidate=>candidate!==null);
  if (!selected) return null;
  return {strategyId:selected.strategyId,direction:selected.direction,regime,evidenceCodes:[`REGIME_${regime}`,...selected.codes]};
}
