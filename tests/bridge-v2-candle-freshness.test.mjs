import test from "node:test";
import assert from "node:assert/strict";
import { readBridgeV2Candles } from "../server/bridge-v2-api.mjs";

function candles(count = 40, timeframe = "M1") {
  const duration = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000 }[timeframe];
  const start = Date.now() - count * duration;
  return Array.from({ length: count }, (_, index) => {
    const openTime = new Date(start + index * duration).toISOString();
    const closeTime = new Date(start + (index + 1) * duration).toISOString();
    return {
      symbol: "XAUUSD", timeframe, openTime, closeTime,
      open: 4000, high: 4001, low: 3999, close: 4000.5,
      tickVolume: 10, isClosed: true
    };
  });
}

function fetchSnapshot(agent) {
  return async () => new Response(JSON.stringify([agent]), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-secret",
  MT5_AGENT_ID: "windows-mt5-demo-01"
};

test("persisted candles are not rejected only because the heartbeat is delayed", async () => {
  const result = await readBridgeV2Candles(env, "M1", 35, fetchSnapshot({
    environment: "DEMO",
    last_seen_at: "2000-01-01T00:00:00.000Z",
    payload: { marketCandles: { M1: { updatedAt: new Date().toISOString(), candles: candles() } } }
  }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.candles.length, 35);
    assert.equal(result.value.timeframe, "M1");
  }
});

test("candle reads remain Demo-only", async () => {
  const result = await readBridgeV2Candles(env, "M1", 35, fetchSnapshot({
    environment: "LIVE",
    payload: { marketCandles: { M1: { candles: candles() } } }
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCode, "BRIDGE_V2_AGENT_NOT_AVAILABLE");
});

test("candle reads reject missing persisted snapshots", async () => {
  const result = await readBridgeV2Candles(env, "M1", 35, fetchSnapshot({
    environment: "DEMO",
    payload: {}
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCode, "BRIDGE_V2_CANDLES_NOT_AVAILABLE");
});
