import test from "node:test";
import assert from "node:assert/strict";
import { readBridgeV2Candles, readBridgeV2Positions, readBridgeV2DailyRisk } from "../server/bridge-v2-api.mjs";

function candles(count=40) {
  const now=Date.now();
  return Array.from({length:count},(_,i)=>{
    const opened=now-(count-i)*60_000;
    return {
      symbol:"XAUUSD",timeframe:"M1",
      openTime:new Date(opened).toISOString(),
      closeTime:new Date(opened+60_000).toISOString(),
      open:2300+i,high:2302+i,low:2299+i,close:2301+i,
      tickVolume:10,isClosed:true
    };
  });
}
function mockFetch(payload) {
  return async (url,init={}) => {
    assert.match(String(url),/\/rest\/v1\/bridge_agents\?/);
    assert.equal(init.headers.apikey,"test-service-key");
    return new Response(JSON.stringify([{environment:"DEMO",last_seen_at:new Date().toISOString(),payload}]),{
      status:200,headers:{"content-type":"application/json"}
    });
  };
}
const env={SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"test-service-key",MT5_AGENT_ID:"windows-mt5-demo-01"};

test("Bridge V2 reads recent closed candle snapshots from a fresh Demo agent",async()=>{
  const bars=candles();
  const result=await readBridgeV2Candles(env,"M1",35,mockFetch({marketCandles:{M1:{candles:bars,updatedAt:new Date().toISOString()}}}));
  assert.equal(result.ok,true);
  assert.equal(result.value.candles.length,35);
  assert.equal(result.value.timeframe,"M1");
});

test("Bridge V2 serves fresh persisted candles despite a delayed heartbeat",async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify([{environment:"DEMO",last_seen_at:new Date(Date.now()-60_000).toISOString(),payload:{marketCandles:{M1:{candles:candles()}}}}]),{
    status:200,headers:{"content-type":"application/json"}
  });
  const result=await readBridgeV2Candles(env,"M1",35,fetchImpl);
  assert.equal(result.ok,true);
  if(result.ok) assert.equal(result.value.candles.length,35);
});

test("Bridge V2 rejects invalid timeframe and count before database access",async()=>{
  const fetchImpl=async()=>{throw new Error("database should not be called");};
  assert.deepEqual(await readBridgeV2Candles(env,"M2",35,fetchImpl),{ok:false,errorCode:"INVALID_CANDLE_REQUEST"});
  assert.deepEqual(await readBridgeV2Candles(env,"M1",10,fetchImpl),{ok:false,errorCode:"INVALID_CANDLE_REQUEST"});
});

test("Bridge V2 exposes positions and risk only from fresh Demo telemetry", async () => {
  const agent = {
    environment: "DEMO",
    account_login: "123456",
    last_seen_at: new Date().toISOString(),
    payload: {
      positions: [{ ticket: 77, symbol: "XAUUSD", direction: "BUY", ownedByBot: true }],
      dailyRisk: {
        accountLogin: "123456", currency: "USD", balance: 1000,
        dailyNetPnl: -3, consecutiveLosses: 2, asOf: new Date().toISOString(),
        dayStartUtc: new Date().toISOString(), source: "MT5_CLOSED_DEALS_BOT_MAGIC"
      }
    }
  };
  const fetchImpl = async () => new Response(JSON.stringify([agent]), {
    status: 200, headers: { "content-type": "application/json" }
  });
  const positions = await readBridgeV2Positions(env, fetchImpl);
  assert.equal(positions.ok, true);
  if (positions.ok) assert.equal(positions.value.positions[0].ticket, 77);
  const risk = await readBridgeV2DailyRisk(env, fetchImpl);
  assert.equal(risk.ok, true);
  if (risk.ok) assert.equal(risk.value.consecutiveLosses, 2);
});
