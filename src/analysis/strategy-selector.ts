import type { Direction } from "../domain/types.js";

export type MarketRegime = "TRENDING" | "RANGING";
export interface StrategySelectionInput {
  readonly trendStrength: number;
  readonly ema9: number;
  readonly ema21: number;
  readonly ema21FiveBarsAgo: number;
  readonly previousEma9: number;
  readonly previousClose: number;
  readonly previousHigh: number;
  readonly previousLow: number;
  readonly currentOpen: number;
  readonly currentClose: number;
  readonly priorRangeHigh: number;
  readonly priorRangeLow: number;
  readonly rsi14: number;
  readonly macdHistogram: number;
  readonly previousMacdHistogram?: number;
  readonly higherTimeframeBias?: "BULLISH" | "BEARISH" | "MIXED";
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
  const values=Object.entries(input).filter(([key,value])=>key!=="higherTimeframeBias"&&value!==undefined).map(([,value])=>value);
  if (values.some(value=>!Number.isFinite(value)) || input.atr14<=0 || input.priorRangeHigh<input.priorRangeLow) return null;
  const regime:MarketRegime=input.trendStrength>=0.25?"TRENDING":"RANGING";
  const trendUp=input.ema9>input.ema21 && input.ema21>input.ema21FiveBarsAgo;
  const trendDown=input.ema9<input.ema21 && input.ema21<input.ema21FiveBarsAgo;
  const bullishCandle=input.currentClose>input.currentOpen;
  const bearishCandle=input.currentClose<input.currentOpen;
  // Continuation is an event, not a persistent trend state: require the latest closed
  // candle to break the previous candle's extreme in the direction of momentum.
  const previousHistogram=input.previousMacdHistogram;
  const bullishMomentum=input.macdHistogram>0 || (input.macdHistogram<=0 && previousHistogram!==undefined && input.macdHistogram>previousHistogram);
  const bearishMomentum=input.macdHistogram<0 || (input.macdHistogram>=0 && previousHistogram!==undefined && input.macdHistogram<previousHistogram);
  const continuationBuy=input.currentClose>input.previousHigh && bullishCandle && input.ema9>input.ema21 && bullishMomentum && input.rsi14>=50 && input.rsi14<75;
  const continuationSell=input.currentClose<input.previousLow && bearishCandle && input.ema9<input.ema21 && bearishMomentum && input.rsi14<=50 && input.rsi14>25;
  const pullbackBuy=trendUp && input.previousClose<=input.previousEma9 && input.currentClose>input.ema9 && bullishCandle && bullishMomentum && input.rsi14>=45 && input.rsi14<75;
  const pullbackSell=trendDown && input.previousClose>=input.previousEma9 && input.currentClose<input.ema9 && bearishCandle && bearishMomentum && input.rsi14<=55 && input.rsi14>25;
  const momentumRecoveryBuy=input.higherTimeframeBias==="BULLISH" && input.trendStrength<0.25 &&
    input.currentClose>input.previousHigh && bullishCandle && bullishMomentum && input.rsi14>=45 && input.rsi14<=70 &&
    input.ema9>=input.ema21-0.2*input.atr14;
  const momentumRecoverySell=input.higherTimeframeBias==="BEARISH" && input.trendStrength<0.25 &&
    input.currentClose<input.previousLow && bearishCandle && input.rsi14>=30 && input.rsi14<=55 &&
    input.ema9<=input.ema21+0.2*input.atr14;
  const breakoutBuy=input.currentClose>input.priorRangeHigh+0.1*input.atr14 && bullishCandle && input.macdHistogram>0 && input.rsi14>=55 && input.rsi14<80;
  const breakoutSell=input.currentClose<input.priorRangeLow-0.1*input.atr14 && bearishCandle && input.macdHistogram<0 && input.rsi14<=45 && input.rsi14>20;

  const recoveryCandidate=momentumRecoveryBuy
    ? {strategyId:"M1_MOMENTUM_RECOVERY_V1",direction:"BUY" as const,codes:["HTF_ALIGNED_MOMENTUM_RECOVERY","CLOSED_BAR_PREVIOUS_HIGH_BROKEN","M1_EMA_NEAR_CROSS"]}
    : momentumRecoverySell
      ? {strategyId:"M1_MOMENTUM_RECOVERY_V1",direction:"SELL" as const,codes:["HTF_ALIGNED_MOMENTUM_RECOVERY","CLOSED_BAR_PREVIOUS_LOW_BROKEN","M1_EMA_NEAR_CROSS"]}
      : null;
  const candidates=regime==="TRENDING"
    ? [
        continuationBuy?{strategyId:"M1_TREND_CONTINUATION_V1",direction:"BUY" as const,codes:["TREND_CONTINUATION","EMA_TREND_CONFIRMED","MACD_MOMENTUM_CONFIRMED"]}:null,
        continuationSell?{strategyId:"M1_TREND_CONTINUATION_V1",direction:"SELL" as const,codes:["TREND_CONTINUATION","EMA_TREND_CONFIRMED","MACD_MOMENTUM_CONFIRMED"]}:null,
        pullbackBuy?{strategyId:"M1_PULLBACK_RECLAIM_V1",direction:"BUY" as const,codes:["PULLBACK_RECLAIM","TREND_SLOPE_CONFIRMED","EMA9_RECLAIM"]}:null,
        pullbackSell?{strategyId:"M1_PULLBACK_RECLAIM_V1",direction:"SELL" as const,codes:["PULLBACK_RECLAIM","TREND_SLOPE_CONFIRMED","EMA9_REJECTION"]}:null
      ]
    : [
        breakoutBuy?{strategyId:"M1_RANGE_BREAKOUT_V1",direction:"BUY" as const,codes:["RANGE_BREAKOUT","CLOSED_BAR_RANGE_HIGH_BROKEN"]}:null,
        breakoutSell?{strategyId:"M1_RANGE_BREAKOUT_V1",direction:"SELL" as const,codes:["RANGE_BREAKOUT","CLOSED_BAR_RANGE_LOW_BROKEN"]}:null
      ];
  const selected=recoveryCandidate??candidates.find(candidate=>candidate!==null);
  if (!selected) return null;
  return {strategyId:selected.strategyId,direction:selected.direction,regime,evidenceCodes:[`REGIME_${regime}`,...selected.codes]};
}
