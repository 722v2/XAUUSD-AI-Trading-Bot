import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAppServer } from '../server.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
}
function close(server) { return new Promise(resolve => server.close(()=>resolve())); }
function candles(timeframe,count,minutes) {
  const latestClose=Date.now()-1000;
  const price=i=>2000+i*0.05+Math.sin((i+8)*0.35)*0.7;
  return Array.from({length:count},(_,i)=>{
    const openMs=latestClose-(count-i)*minutes*60_000;
    const open=price(i-1),close=price(i);
    return {symbol:'XAUUSD',timeframe,openTime:new Date(openMs).toISOString(),closeTime:new Date(openMs+minutes*60_000).toISOString(),open,high:Math.max(open,close)+0.05,low:Math.min(open,close)-0.05,close,tickVolume:100,isClosed:true};
  });
}

test('manual scanner uses authenticated MT5 candles and structured AI without auto-executing', async t => {
  let aiCalls=0;
  const bridge=createServer((req,res)=>{
    if(req.headers['x-bridge-token']!=='bridge-test-token'){res.writeHead(401);res.end(JSON.stringify({error:'UNAUTHORIZED'}));return;}
    res.setHeader('content-type','application/json');
    if(req.url==='/health'){res.end(JSON.stringify({state:'CONNECTED',reason:'DEMO_ACCOUNT_CONFIRMED',environment:'DEMO',accountLogin:'demo-123',executionReady:true,liveTradingEnabled:false}));return;}
    if(req.url.startsWith('/market/candles')){
      const url=new URL(req.url,'http://127.0.0.1');
      const tf=url.searchParams.get('timeframe');
      const count=Number(url.searchParams.get('count'));
      const minutes={M1:1,M5:5,M15:15,H1:60}[tf];
      res.end(JSON.stringify({symbol:'XAUUSD',timeframe:tf,candles:candles(tf,count,minutes)}));return;
    }
    res.writeHead(404);res.end(JSON.stringify({error:'NOT_FOUND'}));
  });
  const ai=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    aiCalls++;
    const request=JSON.parse(raw);
    const user=JSON.parse(request.messages.find(message=>message.role==='user').content);
    const direction=user.evidence?.[0]?.direction;
    const outcome=direction==='BUY'||direction==='SELL'?direction:'WAIT';
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({outcome,rationale:'Test fixture response',rationaleCodes:['TEST_FIXTURE']})}}]}));
  });
  const bridgeUrl=await listen(bridge), aiUrl=await listen(ai);
  const app=createAppServer({MT5_BRIDGE_URL:bridgeUrl,MT5_BRIDGE_TOKEN:'bridge-test-token',AI_API_KEY:'test-key',AI_BASE_URL:aiUrl+'/v1',AI_PROVIDER_ID:'fixture',AI_MODEL_ID:'fixture-model'});
  const appUrl=await listen(app);
  t.after(async()=>{await close(app);await close(bridge);await close(ai);});
  const response=await fetch(appUrl+'/api/scan',{method:'POST'});
  const data=await response.json();
  assert.equal(response.status,200);
  assert.ok(['BUY','SELL','WAIT'].includes(data.status));
  assert.equal(data.execution,'NOT_SUBMITTED');
  assert.equal(data.run.triggerType,'MANUAL');
  assert.equal(data.chartCandles.length,60);
  assert.ok(['TRENDING','RANGING'].includes(data.analysis.metrics.marketRegime));
  assert.ok(['M1_TREND_CONTINUATION_V1','M1_PULLBACK_RECLAIM_V1','M1_RANGE_BREAKOUT_V1'].includes(data.analysis.evidence[0].strategyId));
  assert.ok(aiCalls>=1,'AI adapter should be called when the deterministic technical setup is ready');
});
