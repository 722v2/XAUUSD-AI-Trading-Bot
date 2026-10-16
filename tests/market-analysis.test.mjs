import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, macd, atr, normalizeQuote, normalizeClosedCandles, analyzeClosedMarket } from '../dist/index.js';

test('EMA returns null before its seed period and never looks ahead', () => {
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
});
test('RSI handles flat and one-directional series deterministically', () => {
  assert.equal(rsi([5, 5, 5, 5], 2)[2], 50);
  assert.equal(rsi([1, 2, 3, 4], 2)[3], 100);
});
test('MACD and ATR preserve warm-up nulls', () => {
  assert.equal(macd(Array.from({ length: 20 }, (_, i) => i + 1)).every(x => x === null), true);
  assert.equal(atr([2, 3, 4], [1, 2, 3], [1.5, 2.5, 3.5], 2)[0], null);
  assert.equal(atr([2, 3, 4], [1, 2, 3], [1.5, 2.5, 3.5], 2)[1], 1.5);
});
test('quote normalization rejects crossed quotes and accepts valid XAUUSD quotes', () => {
  assert.equal(normalizeQuote({symbol:'XAUUSD',bid:2010,ask:2009,tickTime:'2026-10-16T12:00:00Z'}).ok, false);
  assert.equal(normalizeQuote({symbol:'XAUUSD',bid:2010,ask:2010.1,tickTime:'2026-10-16T12:00:00Z'}).ok, true);
});
test('candle normalization rejects open, duplicate and unordered bars', () => {
  const make = (minute, closed = true) => ({symbol:'XAUUSD',timeframe:'M1',openTime:Date.UTC(2026,9,16,12,minute),closeTime:Date.UTC(2026,9,16,12,minute+1),open:2000,high:2002,low:1999,close:2001,tickVolume:2,isClosed:closed});
  assert.equal(normalizeClosedCandles([make(0,false)], 'M1').ok, false);
  assert.equal(normalizeClosedCandles([make(0),make(0)], 'M1').ok, false);
  assert.equal(normalizeClosedCandles([make(1),make(0)], 'M1').ok, false);
});
test('analysis refuses stale or insufficient closed M1 history', () => {
  const now = '2026-10-16T12:40:00.000Z';
  const empty = {M1:[],M5:[],M15:[],H1:[]};
  assert.equal(analyzeClosedMarket({symbol:'XAUUSD',candles:empty,now}).reason, 'INSUFFICIENT_HISTORY');
  const candles = Array.from({length:40},(_,i)=>({symbol:'XAUUSD',timeframe:'M1',openTime:new Date(Date.parse(now)-(40-i)*60_000).toISOString(),closeTime:new Date(Date.parse(now)-(39-i)*60_000).toISOString(),open:2000+i,high:2002+i,low:1999+i,close:2001+i,tickVolume:1,isClosed:true}));
  assert.equal(analyzeClosedMarket({symbol:'XAUUSD',candles:{M1:candles,M5:[],M15:[],H1:[]},now}).status, 'NO_ANALYSIS');
});
