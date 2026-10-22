import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.mjs';

async function withServer(run) {
  const server = createAppServer({});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address = server.address();
  try { await run('http://127.0.0.1:'+address.port); }
  finally { await new Promise(resolve=>server.close(resolve)); }
}
test('public dashboard requires Basic authentication for UI and API routes', async () => {
  const server=createAppServer({DASHBOARD_USERNAME:'deploy-admin',DASHBOARD_PASSWORD:'a-long-test-password'});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  const base='http://127.0.0.1:'+address.port;
  try {
    const denied=await fetch(base+'/');
    assert.equal(denied.status,401);
    assert.match(denied.headers.get('www-authenticate')||'',/Basic/);
    const deniedApi=await fetch(base+'/api/health');
    assert.equal(deniedApi.status,401);
    const auth='Basic '+Buffer.from('deploy-admin:a-long-test-password').toString('base64');
    const allowed=await fetch(base+'/',{headers:{authorization:auth}});
    assert.equal(allowed.status,200);
    const allowedApi=await fetch(base+'/api/health',{headers:{authorization:auth}});
    assert.equal(allowedApi.status,200);
    const wrong=await fetch(base+'/',{headers:{authorization:'Basic '+Buffer.from('deploy-admin:wrong').toString('base64')}});
    assert.equal(wrong.status,401);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('dashboard serves its HTML, CSS and JavaScript assets', async () => {
  await withServer(async base => {
    for (const path of ['/', '/styles.css', '/app.js']) {
      const response = await fetch(base+path);
      assert.equal(response.status,200,path);
      assert.ok((await response.text()).length>0,path);
    }
  });
});
test('health API reports not-ready services honestly and keeps live disabled', async () => {
  await withServer(async base => {
    const response = await fetch(base+'/api/health');
    const data = await response.json();
    assert.equal(response.status,200);
    assert.equal(data.marketData.state,'NOT_CONFIGURED');
    assert.equal(data.scanner.state,'NOT_READY');
    assert.equal(data.execution.state,'DISABLED');
  });
});
test('historical backtest rejects arbitrary AI providers and never defaults to a model', async () => {
  await withServer(async base => {
    const response = await fetch(base+'/api/backtest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      useAI:true,providerId:'untrusted-provider',modelId:'untrusted-model',barsCount:100,lots:0.01,
      spreadPrice:0.2,slippagePrice:0,commissionPerLot:0,maxAiCalls:5
    })});
    const data = await response.json();
    assert.equal(response.status,400);
    assert.equal(data.error,'AI_MODEL_NOT_ALLOWLISTED');
  });
});
test('AI connectivity test refuses an unconfigured provider without changing execution state', async () => {
  await withServer(async base => {
    const response=await fetch(base+'/api/ai/test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    const data=await response.json();
    assert.equal(response.status,409);
    assert.equal(data.error,'AI_NOT_CONFIGURED');
    const config=await (await fetch(base+'/api/config')).json();
    assert.equal(config.autoTradingEnabled,false);
    assert.equal(config.liveTradingEnabled,false);
  });
});
test('manual scanner is independent of MT5 and reports only market-data failure when Biquote is unavailable', async () => {
  const server=createAppServer({BIQUOTE_BASE_URL:'http://127.0.0.1:1'});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+server.address().port;
  try {
    const response=await fetch(base+'/api/scan',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    const data=await response.json();
    assert.equal(response.status,503);
    assert.equal(data.error,'MARKET_DATA_UNAVAILABLE');
    assert.notEqual(data.error,'SCANNER_NOT_READY');
    assert.equal(data.run.reason,'MARKET_DATA_UNAVAILABLE');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('risk API validates settings and marks non-durable saves honestly', async () => {
  await withServer(async base => {
    const response = await fetch(base+'/api/config/risk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'PERCENT_OF_CAPITAL',referenceCapital:100,riskPercent:1,minimumRiskRewardRatio:2})});
    const data = await response.json();
    assert.equal(response.status,200);
    assert.equal(data.persisted,false);
    const invalid = await fetch(base+'/api/config/risk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'FIXED_CASH',referenceCapital:0,riskCash:-1,minimumRiskRewardRatio:2})});
    assert.equal(invalid.status,400);
  });
});

test('auto execution stays off and Live remains disabled without all prerequisites', async () => {
  await withServer(async base => {
    const configResponse = await fetch(base+'/api/config');
    const config = await configResponse.json();
    assert.equal(config.autoTradingEnabled,false);
    assert.equal(config.liveTradingEnabled,false);
    const response = await fetch(base+'/api/trading/auto',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})});
    const data = await response.json();
    assert.equal(response.status,409);
    assert.equal(data.error,'DAILY_RISK_LIMITS_NOT_CONFIGURED');
  });
});
test('positions API never invents positions when MT5 bridge is absent', async () => {
  await withServer(async base => {
    const response = await fetch(base+'/api/positions');
    const data = await response.json();
    assert.equal(response.status,503);
    assert.deepEqual(data.positions,[]);
  });
});

test('Live environment cannot be selected without explicit server-side gates', async () => {
  await withServer(async base => {
    const response=await fetch(base+'/api/trading/environment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({environment:'LIVE',confirmation:'I_UNDERSTAND_LIVE_TRADING_RISK'})});
    const data=await response.json();
    assert.equal(response.status,403);
    assert.equal(data.error,'LIVE_NOT_AUTHORIZED');
  });
});
