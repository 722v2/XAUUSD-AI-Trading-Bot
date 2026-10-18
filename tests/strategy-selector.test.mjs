import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAdaptiveStrategy } from '../dist/index.js';

const base={trendStrength:0.5,ema9:101,ema21:100,ema21FiveBarsAgo:99,previousEma9:100,previousClose:99,currentOpen:101,currentClose:102,priorRangeHigh:103,priorRangeLow:98,rsi14:60,macdHistogram:0.5,atr14:2};
test('adaptive selector chooses continuation in a strong directional regime',()=>{
  const selected=selectAdaptiveStrategy(base);
  assert.equal(selected.strategyId,'M1_TREND_CONTINUATION_V1');
  assert.equal(selected.direction,'BUY');
  assert.equal(selected.regime,'TRENDING');
});
test('adaptive selector chooses pullback reclaim when trend continues but momentum is not extended',()=>{
  const selected=selectAdaptiveStrategy({...base,rsi14:48});
  assert.equal(selected.strategyId,'M1_PULLBACK_RECLAIM_V1');
  assert.equal(selected.direction,'BUY');
});
test('adaptive selector prioritizes a closed-bar range breakout in a weak-trend regime',()=>{
  const selected=selectAdaptiveStrategy({...base,trendStrength:0.1,ema9:99,ema21:100,ema21FiveBarsAgo:100,priorRangeHigh:101,currentClose:102,rsi14:60});
  assert.equal(selected.strategyId,'M1_RANGE_BREAKOUT_V1');
  assert.equal(selected.direction,'BUY');
  assert.ok(selected.evidenceCodes.includes('CLOSED_BAR_RANGE_HIGH_BROKEN'));
});
test('adaptive selector is directionally symmetric for sell setups',()=>{
  const selected=selectAdaptiveStrategy({...base,trendStrength:0.5,ema9:99,ema21:100,ema21FiveBarsAgo:101,previousEma9:100,previousClose:101,currentOpen:99,currentClose:98,priorRangeHigh:102,priorRangeLow:97,rsi14:40,macdHistogram:-0.5});
  assert.equal(selected.strategyId,'M1_TREND_CONTINUATION_V1');
  assert.equal(selected.direction,'SELL');
});
test('adaptive selector rejects invalid inputs and does not invent a setup',()=>{
  assert.equal(selectAdaptiveStrategy({...base,atr14:0}),null);
  assert.equal(selectAdaptiveStrategy({...base,trendStrength:0.1,ema9:100,ema21:100,ema21FiveBarsAgo:100,previousClose:101,currentClose:100,currentOpen:100.5,priorRangeHigh:101,priorRangeLow:98,rsi14:50,macdHistogram:0}),null);
});

test('ranging regime does not fall back to trend continuation without a breakout',()=>{
  const selected=selectAdaptiveStrategy({...base,trendStrength:0.1,priorRangeHigh:103,currentClose:102});
  assert.equal(selected,null);
});
test('trending regime does not admit a range-breakout-only candidate',()=>{
  const selected=selectAdaptiveStrategy({...base,trendStrength:0.5,ema9:99,ema21:100,ema21FiveBarsAgo:101,previousEma9:100,previousClose:101,currentOpen:99,currentClose:98,priorRangeLow:90,priorRangeHigh:110,rsi14:40,macdHistogram:-0.5});
  assert.equal(selected.strategyId,'M1_TREND_CONTINUATION_V1');
});
