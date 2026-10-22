import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAIProvider, AIProviderError, coordinateTechnicalAndAI } from '../dist/index.js';

const evidence = [{strategyId:'s1',direction:'BUY',evidenceCodes:['EMA_UP'],entryPrice:2000,stopLoss:1990,takeProfit:2020,createdAt:'2026-10-16T12:00:00.000Z',expiresAt:'2026-10-16T12:01:00.000Z'}];
const config = {providerId:'test-provider',modelId:'test-model',baseUrl:'https://ai.example/v1',apiKey:'test-secret',timeoutMs:1000};
const response = (payload, status=200) => new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});

test('AI adapter parses only structured assessments and never issues an execution action', async () => {
  let captured;
  const provider = new OpenAICompatibleAIProvider(config, async (url, init) => {
    captured = {url:String(url),headers:init.headers,body:JSON.parse(init.body)};
    return response({choices:[{message:{content:JSON.stringify({outcome:'BUY',rationale:'Evidence aligned',rationaleCodes:['EMA_UP']})}}]});
  });
  const result = await provider.assess({symbol:'XAUUSD',evidence,now:'2026-10-16T12:00:00.000Z',marketContext:{recentClosedM1:[{time:'2026-10-16T11:59:00.000Z',open:2000,high:2002,low:1999,close:2001}]}});
  assert.equal(result.outcome,'BUY');
  assert.equal(result.providerId,'test-provider');
  assert.equal(captured.body.model,'test-model');
  const userMessage=captured.body.messages.find(message=>message.role==='user');
  assert.equal(JSON.parse(userMessage.content).marketContext.recentClosedM1.length,1);
  assert.equal(captured.headers.authorization,'Bearer test-secret');
  assert.equal(JSON.stringify(captured.body).includes('place_order'),false);
});
test('AI adapter rejects malformed response and non-HTTPS remote endpoints', async () => {
  const malformed = new OpenAICompatibleAIProvider(config, async () => response({choices:[{message:{content:'not json'}}]}));
  await assert.rejects(malformed.assess({symbol:'XAUUSD',evidence,now:'2026-10-16T12:00:00Z'}), e => e instanceof AIProviderError && e.code === 'INVALID_RESPONSE');
  const insecure = new OpenAICompatibleAIProvider({...config,baseUrl:'http://remote.example/v1'}, async () => response({}));
  await assert.rejects(insecure.assess({symbol:'XAUUSD',evidence,now:'2026-10-16T12:00:00Z'}), e => e instanceof AIProviderError && e.code === 'INVALID_CONFIG');
});
test('decision coordinator blocks technical/AI direction conflicts', () => {
  const base = {providerId:'p',modelId:'m',outcome:'SELL',rationaleCodes:[],rationale:'disagree',assessedAt:'2026-10-16T12:00:00Z',expiresAt:'2026-10-16T12:01:00Z'};
  assert.deepEqual(coordinateTechnicalAndAI(evidence,base),{outcome:'WAIT',reasonCodes:['AI_TECHNICAL_DIRECTION_CONFLICT']});
  assert.equal(coordinateTechnicalAndAI(evidence,{...base,outcome:'BUY'}).outcome,'BUY');
  assert.equal(coordinateTechnicalAndAI([],{...base,outcome:'WAIT'}).outcome,'REJECT');
});

test('AI provider timeout is bounded and aborts stalled requests with a diagnostic code', async () => {
  const invalidTimeout = new OpenAICompatibleAIProvider({...config,timeoutMs:45001}, async () => response({}));
  await assert.rejects(invalidTimeout.assess({symbol:'XAUUSD',evidence,now:'2026-10-16T12:00:00Z'}), e => e instanceof AIProviderError && e.code === 'INVALID_CONFIG');
  const stalled = new OpenAICompatibleAIProvider({...config,timeoutMs:1000}, async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name:'AbortError'})), {once:true});
  }));
  await assert.rejects(stalled.assess({symbol:'XAUUSD',evidence,now:'2026-10-16T12:00:00Z'}), e => e instanceof AIProviderError && e.code === 'TIMEOUT');
});
