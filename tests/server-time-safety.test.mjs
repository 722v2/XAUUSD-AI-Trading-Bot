import test from 'node:test';
import assert from 'node:assert/strict';
import { economicCalendarBlock, scanFreshnessPolicy, tradingTimeBlock } from '../server.mjs';

test('manual scan permits a closed M1 candle for up to 70 seconds', () => {
  assert.deepEqual(scanFreshnessPolicy('MANUAL'), {maxAgeSeconds:70,maxM1AgeMs:70000});
});

test('scheduled scan keeps the stricter 20-second analysis freshness limit', () => {
  assert.deepEqual(scanFreshnessPolicy('SCHEDULED'), {maxAgeSeconds:35,maxM1AgeMs:20000});
});

test('rollover blackout follows New York daylight saving time in October', () => {
  // 20:57 UTC is 16:57 EDT on 2026-10-19.
  assert.equal(tradingTimeBlock({}, Date.parse('2026-10-19T20:57:00Z')), 'ROLLOVER_BLACKOUT');
  assert.equal(tradingTimeBlock({}, Date.parse('2026-10-19T20:50:00Z')), null);
});

test('rollover blackout follows New York standard time after DST ends', () => {
  // 21:57 UTC is 16:57 EST on 2026-11-02.
  assert.equal(tradingTimeBlock({}, Date.parse('2026-11-02T21:57:00Z')), 'ROLLOVER_BLACKOUT');
  assert.equal(tradingTimeBlock({}, Date.parse('2026-11-02T21:50:00Z')), null);
});

test('manual news blackout configuration still blocks entries', () => {
  const now = Date.parse('2026-10-19T14:00:00Z');
  assert.equal(tradingTimeBlock({HIGH_IMPACT_NEWS_BLACKOUTS_UTC:'2026-10-19T13:55:00Z/2026-10-19T14:05:00Z'}, now), 'HIGH_IMPACT_NEWS_BLACKOUT');
});

test('automatic news filter fails closed when its provider is not configured', async () => {
  assert.equal(await economicCalendarBlock({}, Date.now(), async () => { throw new Error('must not fetch'); }), 'NEWS_CALENDAR_NOT_CONFIGURED');
});

test('automatic news filter blocks high-impact US events inside the 15-minute window', async () => {
  const now=Date.now();
  const fetchImpl=async (url,init) => {
    assert.match(String(url),/finnhub\.io\/api\/v1\/calendar\/economic/);
    assert.ok(init.signal);
    return new Response(JSON.stringify({economicCalendar:[
      {country:'US',impact:3,time:new Date(now+5*60*1000).toISOString(),event:'High impact'},
      {country:'US',impact:1,time:new Date(now).toISOString(),event:'Low impact'}
    ]}),{status:200});
  };
  assert.equal(await economicCalendarBlock({FINNHUB_API_KEY:'test-key'},now,fetchImpl),'HIGH_IMPACT_NEWS_BLACKOUT');
});
