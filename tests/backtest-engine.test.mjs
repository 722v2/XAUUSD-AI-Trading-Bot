import test from "node:test";
import assert from "node:assert/strict";
import { runHistoricalBacktest } from "../server/backtest-engine.mjs";

function candle(time, tf, open, high, low, close) {
  const ms = Date.parse(time);
  const minutes = tf === "M1" ? 1 : tf === "M5" ? 5 : tf === "M15" ? 15 : 60;
  return { symbol: "XAUUSD", timeframe: tf, openTime: new Date(ms).toISOString(), closeTime: new Date(ms + minutes * 60000).toISOString(), open, high, low, close, tickVolume: 10, isClosed: true };
}
test("backtest refuses invalid ranges before bridge calls", async () => {
  await assert.rejects(() => runHistoricalBacktest({
    bridge: {}, aiProvider: {}, request: { barsCount: 99, lots: 0.01, spreadPrice: 0.2, commissionPerLot: 0, maxAiCalls: 5 }
  }), error => error.status === 400 && error.code === "INVALID_BACKTEST_CONFIG");
});
test("historical backtest uses closed MT5 candles, AI agreement, costs, and never sends orders", async () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const bars = Array.from({ length: 120 }, (_, i) => {
    const base = 2000 + i * 0.08;
    return candle(new Date(start + i * 60000).toISOString(), "M1", base, base + 0.6, base - 0.2, base + 0.4);
  });
  const makeContext = tf => Array.from({ length: 80 }, (_, i) => candle(new Date(start + i * (tf === "M5" ? 300000 : tf === "M15" ? 900000 : 3600000)).toISOString(), tf, 2000+i, 2001+i, 1999+i, 2000.5+i));
  const bridge = {
    health: async () => ({ ok: true, value: { state: "CONNECTED", environment: "DEMO" } }),
    candles: async (tf,count) => ({ ok:true,value:{symbol:"XAUUSD",timeframe:tf,candles:(tf==="M1"?bars:makeContext(tf)).slice(0,count)} }),
    symbolSpec: async () => ({ok:true,value:{tickSize:0.01,tickValuePerLot:1,volumeMin:0.01,volumeMax:100,volumeStep:0.01,priceDigits:2}}),
    quote: async () => ({ok:true,value:{bid:2000,ask:2000.2}})
  };
  let calls = 0;
  const aiProvider = { assess: async ({evidence,now}) => { calls++; return {providerId:"test",modelId:"test-model",outcome:evidence[0].direction,rationale:"aligned",rationaleCodes:[],assessedAt:now,expiresAt:now}; } };
  const result = await runHistoricalBacktest({
    bridge, aiProvider, aiProviderId:"test", aiModelId:"test-model",
    request:{barsCount:100,lots:0.01,spreadPrice:0.2,slippagePrice:0.05,commissionPerLot:1,maxAiCalls:5,useAI:true},
    normalizeClosedCandles:(raw,tf,min)=>({ok:true,value:raw.slice(-min)}),
    analyzeClosedMarket:({candles,now}) => {
      const nowMs=Date.parse(now);
      assert.ok(candles.M1.every(bar=>Date.parse(bar.closeTime)<=nowMs),"M1 lookahead detected");
      for (const tf of ["M5","M15","H1"]) assert.ok(candles[tf].every(bar=>Date.parse(bar.closeTime)<=nowMs),tf+" lookahead detected");
      const n=candles.M1.length;
      if (n < 36 || n % 20 !== 0) return {status:"WAIT",evidence:[]};
      const bar=candles.M1[n-1];
      return {status:"READY",evidence:[{symbol:"XAUUSD",strategyId:"TEST",direction:"BUY",evidenceCodes:[],entryPrice:bar.close,stopLoss:bar.close-0.5,takeProfit:bar.close+1.0,createdAt:now,expiresAt:now}]};
    },
    coordinateTechnicalAndAI: (evidence,ai) => ({outcome:evidence[0].direction===ai.outcome?ai.outcome:"WAIT"})
  });
  assert.equal(result.ok,true);
  assert.equal(result.assumptions.noLookahead,true);
  assert.equal(result.assumptions.liveOrdersSent,false);
  assert.equal(result.assumptions.slippagePrice,0.05);
  assert.equal(result.assumptions.spreadPrice,0.2);
  assert.equal(result.assumptions.spreadModel,"UTC_SESSION_APPROXIMATION_NOT_TICK_HISTORY");
  assert.equal(result.assumptions.breakEvenAtR,1.2);
  assert.equal(result.assumptions.trailingStartsAtR,1.5);
  assert.equal(result.metrics.aiCalls,calls);
  assert.ok(result.data.receivedBars >= 100);
  assert.ok(Array.isArray(result.trades));
  assert.ok(result.metrics.trades >= 1);
});

test("technical-only backtest runs without an AI provider across all candidates", async () => {
  const start=Date.parse("2026-02-01T00:00:00Z");
  const bars=Array.from({length:120},(_,i)=>{
    const base=2000+i*0.1;
    return candle(new Date(start+i*60000).toISOString(),"M1",base,base+0.7,base-0.1,base+0.5);
  });
  const context=tf=>Array.from({length:80},(_,i)=>candle(new Date(start+i*(tf==="M5"?300000:tf==="M15"?900000:3600000)).toISOString(),tf,2000+i,2002+i,1998+i,2001+i));
  const bridge={
    health:async()=>({ok:true,value:{state:"CONNECTED",environment:"DEMO"}}),
    candles:async(tf,count)=>({ok:true,value:{symbol:"XAUUSD",timeframe:tf,candles:(tf==="M1"?bars:context(tf)).slice(0,count)}}),
    symbolSpec:async()=>({ok:true,value:{tickSize:0.01,tickValuePerLot:1,volumeMin:0.01,volumeMax:100,volumeStep:0.01,priceDigits:2}})
  };
  const result=await runHistoricalBacktest({
    bridge,aiProvider:null,request:{barsCount:100,lots:0.01,spreadPrice:0.2,slippagePrice:0.01,commissionPerLot:0,maxAiCalls:1,useAI:false},
    normalizeClosedCandles:(raw,tf,min)=>({ok:true,value:raw.slice(-min)}),
    analyzeClosedMarket:({candles,now})=>{
      const nowMs=Date.parse(now);
      assert.ok(candles.M1.every(bar=>Date.parse(bar.closeTime)<=nowMs),"no-lookahead invariant");
      const bar=candles.M1.at(-1);
      return {status:candles.M1.length>=36?"READY":"WAIT",evidence:candles.M1.length>=36?[{symbol:"XAUUSD",strategyId:"BASELINE",direction:"BUY",entryPrice:bar.close,stopLoss:bar.close-0.5,takeProfit:bar.close+1,createdAt:now,expiresAt:now}]:[]};
    }
  });
  assert.equal(result.mode,"HISTORICAL_TECHNICAL_BACKTEST");
  assert.equal(result.ai.used,false);
  assert.equal(result.metrics.aiCalls,0);
  assert.ok(result.metrics.candidateSignals>1);
  assert.equal(result.assumptions.liveOrdersSent,false);
});
