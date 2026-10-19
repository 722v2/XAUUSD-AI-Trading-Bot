import test from 'node:test';
import assert from 'node:assert/strict';
import { economicCalendarBlock, evaluateDailyRiskGuard, scanFreshnessPolicy, tradingTimeBlock } from '../server.mjs';

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

test('automatic news filter fails closed on provider authentication errors', async () => {
  const result=await economicCalendarBlock({FINNHUB_API_KEY:'invalid-provider-key'},Date.now()+48*60*60*1000,async () => new Response('unauthorized',{status:401}));
  assert.equal(result,'NEWS_CALENDAR_UNAVAILABLE');
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

test('automatic news filter protects 45 minutes after release but only 15 minutes before', async () => {
  const now=Date.parse('2026-10-19T14:00:00Z');
  const provider=async () => new Response(JSON.stringify({economicCalendar:[
    {country:'US',impact:3,time:new Date(now-40*60*1000).toISOString(),event:'Post-release volatility'}
  ]}),{status:200});
  assert.equal(await economicCalendarBlock({FINNHUB_API_KEY:'asymmetric-window-key'},now,provider),'HIGH_IMPACT_NEWS_BLACKOUT');
});

test('automatic news filter accepts Finnhub string high-impact labels', async () => {
  const now=Date.now()+2*60*60*1000;
  const result=await economicCalendarBlock({FINNHUB_API_KEY:'string-impact-key'},now,async () => new Response(JSON.stringify({economicCalendar:[
    {country:'US',impact:'high',time:new Date(now-5*60*1000).toISOString().replace('T',' ').replace('Z',''),event:'CPI'}
  ]}),{status:200}));
  assert.equal(result,'HIGH_IMPACT_NEWS_BLACKOUT');
});

test('economic calendar cache is isolated by API key', async () => {
  const now=Date.now();
  let calls=0;
  const provider=async (_url,_init) => {
    calls++;
    return new Response(JSON.stringify({economicCalendar:[
      {country:'US',impact:'low',time:new Date(now).toISOString(),event:'Low impact'}
    ]}),{status:200});
  };
  assert.equal(await economicCalendarBlock({FINNHUB_API_KEY:'cache-key-a'},now,provider),null);
  const second=await economicCalendarBlock({FINNHUB_API_KEY:'cache-key-b'},now,provider);
  assert.equal(second,null);
  assert.equal(calls,2);
});

test('daily risk guard rejects missing or invalid account-specific limits', () => {
  const risk={accountLogin:'123',currency:'USD',balance:1000,dailyNetPnl:0,consecutiveLosses:0,source:'MT5_CLOSED_DEALS_BOT_MAGIC'};
  assert.equal(evaluateDailyRiskGuard({},risk,'123').code,'DAILY_RISK_LIMITS_NOT_CONFIGURED');
  assert.equal(evaluateDailyRiskGuard({MAX_DAILY_LOSS_PERCENT:'101',MAX_CONSECUTIVE_LOSSES:'3'},risk,'123').code,'DAILY_RISK_LIMITS_NOT_CONFIGURED');
});

test('daily risk guard stops at the configured realized-loss threshold', () => {
  const risk={accountLogin:'123',currency:'USD',balance:1000,dailyNetPnl:-30,consecutiveLosses:1,source:'MT5_CLOSED_DEALS_BOT_MAGIC',dayStartUtc:'2026-10-19T00:00:00Z'};
  const result=evaluateDailyRiskGuard({MAX_DAILY_LOSS_PERCENT:'3',MAX_CONSECUTIVE_LOSSES:'4'},risk,'123');
  assert.equal(result.ok,false);
  assert.equal(result.code,'DAILY_LOSS_LIMIT_REACHED');
  assert.equal(result.dailyLossPercent,3);
});

test('daily risk guard stops at the configured consecutive-loss threshold', () => {
  const risk={accountLogin:'123',currency:'USD',balance:1000,dailyNetPnl:-2,consecutiveLosses:3,source:'MT5_CLOSED_DEALS_BOT_MAGIC'};
  assert.equal(evaluateDailyRiskGuard({MAX_DAILY_LOSS_PERCENT:'5',MAX_CONSECUTIVE_LOSSES:'3'},risk,'123').code,'CONSECUTIVE_LOSS_LIMIT_REACHED');
});

test('daily risk guard rejects stale account identity and malformed telemetry', () => {
  const risk={accountLogin:'999',balance:1000,dailyNetPnl:0,consecutiveLosses:0,source:'MT5_CLOSED_DEALS_BOT_MAGIC'};
  const env={MAX_DAILY_LOSS_PERCENT:'5',MAX_CONSECUTIVE_LOSSES:'3'};
  assert.equal(evaluateDailyRiskGuard(env,risk,'123').code,'DAILY_RISK_HISTORY_UNAVAILABLE');
  assert.equal(evaluateDailyRiskGuard(env,{...risk,accountLogin:'123',balance:0},'123').code,'DAILY_RISK_HISTORY_UNAVAILABLE');
});
