import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.mjs';

function listen(server) { return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port))); }
function close(server) { return new Promise(resolve=>server.close(()=>resolve())); }

test('AI provider/model IDs are manually selected and API keys never leave server environment',async t=>{
  const server=createAppServer({AI_PROVIDER_ID:'provider-a',AI_PROVIDER_LABEL:'Provider A',AI_BASE_URL:'https://api.example.com/v1',AI_API_KEY:'private-secret',AI_ALLOWED_MODELS:'model-a,model-b'});
  const base=await listen(server);t.after(()=>close(server));
  const listResponse=await fetch(base+'/api/ai/providers');
  const list=await listResponse.json();
  assert.equal(list.configured,true);
  assert.equal(list.providerId,'provider-a');
  assert.equal(Object.hasOwn(list,'selectedModelId'),false);
  assert.equal(JSON.stringify(list).includes('private-secret'),false);
  const saved=await fetch(base+'/api/ai/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({providerId:'provider-a',modelId:'model-b'})});
  const savedBody=await saved.json();
  assert.equal(saved.status,200);
  assert.equal(savedBody.modelId,'model-b');
  assert.equal(savedBody.persisted,false);
  const config=await (await fetch(base+'/api/config')).json();
  assert.equal(config.aiModelId,'model-b');
  const rejected=await fetch(base+'/api/ai/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({providerId:'unlisted',modelId:'https://attacker.invalid'})});
  assert.equal(rejected.status,400);
});
