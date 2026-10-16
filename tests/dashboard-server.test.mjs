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
      providerId:'untrusted-provider',modelId:'untrusted-model',barsCount:100,lots:0.01,
      spreadPrice:0.2,slippagePrice:0,commissionPerLot:0,maxAiCalls:5
    })});
    const data = await response.json();
    assert.equal(response.status,400);
    assert.equal(data.error,'AI_MODEL_NOT_ALLOWLISTED');
  });
});
test('manual scan fails closed when MT5 is not connected', async () => {
  await withServer(async base => {
    const response = await fetch(base+'/api/scan',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    const data = await response.json();
    assert.equal(response.status,409);
    assert.equal(data.error,'SCANNER_NOT_READY');
    assert.match(data.message,/لم يتم توليد إشارة/);
  });
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
    assert.equal(data.error,'EXECUTION_PREREQUISITES_MISSING');
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
