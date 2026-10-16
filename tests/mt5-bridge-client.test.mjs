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
test('MT5 bridge client blocks remote plain HTTP and missing token', () => {
  assert.throws(()=>new MT5BridgeClient({baseUrl:'http://remote.example',token:'x'}),/HTTPS/);
  assert.throws(()=>new MT5BridgeClient({baseUrl:'http://127.0.0.1:8765',token:' '}),/token/);
});
test('MT5 bridge client refuses live orders before making any network request', async () => {
  let calls=0;
  const client = new MT5BridgeClient({baseUrl:'http://127.0.0.1:8765',token:'bridge-test-token'},async()=>{calls++;return new Response('{}');});
  const result = await client.submitDemoOrder({intent:{environment:'LIVE'}});
  assert.equal(result.ok,false);
  assert.equal(result.errorCode,'BROKER_REJECTED');
  assert.equal(calls,0);
});
