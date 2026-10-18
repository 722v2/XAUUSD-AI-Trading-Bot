import test from 'node:test';
import assert from 'node:assert/strict';
import { MT5BridgeClient } from '../dist/index.js';

test('MT5 bridge client authenticates and parses readiness state', async () => {
  let captured;
  const client = new MT5BridgeClient({baseUrl:'http://127.0.0.1:8765',token:'bridge-test-token'},async (url,init) => {
    captured={url:String(url),headers:init.headers};
    return new Response(JSON.stringify({state:'CONNECTED',reason:'DEMO_ACCOUNT_CONFIRMED',environment:'DEMO',liveTradingEnabled:false}),{status:200});
  });
  const result = await client.health();
  assert.equal(result.ok,true);
  assert.equal(captured.headers['X-Bridge-Token'],'bridge-test-token');
  assert.equal(result.value.liveTradingEnabled,false);
});
test('MT5 bridge client requests closed historical candles with an extended data timeout', async () => {
  let captured;
  const client = new MT5BridgeClient({baseUrl:'http://127.0.0.1:8765',token:'bridge-test-token'},async (url,init) => {
    captured={url:String(url),token:init.headers['X-Bridge-Token'],signal:init.signal};
    return new Response(JSON.stringify({symbol:'XAUUSD',timeframe:'M1',candles:[]}),{status:200});
  });
  const result=await client.candles('M1',50000);
  assert.equal(result.ok,true);
  assert.match(captured.url,/\/market\/candles\?timeframe=M1&count=5000$/);
  assert.equal(captured.token,'bridge-test-token');
  assert.ok(captured.signal);
});
test('MT5 bridge client blocks remote plain HTTP and missing token', () => {
  assert.throws(()=>new MT5BridgeClient({baseUrl:'http://remote.example',token:'x'}),/HTTPS/);
  assert.throws(()=>new MT5BridgeClient({baseUrl:'http://127.0.0.1:8765',token:' '}),/token/);
});
test('MT5 bridge client passes the explicitly selected execution environment to the authenticated bridge', async () => {
  let calls=0;
  const client = new MT5BridgeClient({baseUrl:'http://127.0.0.1:8765',token:'bridge-test-token'},async(url,init)=>{calls++;assert.equal(String(url),'http://127.0.0.1:8765/orders');assert.equal(JSON.parse(init.body).environment,'LIVE');return new Response(JSON.stringify({state:'CONFIRMED',brokerOrderId:'test-order'}),{status:200});});
  const result = await client.submitOrder({intent:{environment:'LIVE',idempotencyKey:'live-test',direction:'BUY',volume:0.01,stopLoss:2300,takeProfit:2400}});
  assert.equal(result.ok,true);
  assert.equal(calls,1);
});
