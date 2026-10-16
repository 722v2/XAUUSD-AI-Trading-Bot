import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseRestRepository } from '../dist/index.js';

const intent = {
  id:'11111111-1111-4111-8111-111111111111',
  idempotencyKey:'candidate-abc-demo',
  opportunityId:'22222222-2222-4222-8222-222222222222',
  decisionId:'33333333-3333-4333-8333-333333333333',
  environment:'DEMO',symbol:'XAUUSD',direction:'BUY',volume:0.1,stopLoss:1990,takeProfit:2020,
  createdAt:'2026-10-16T12:00:00.000Z'
};
const row = {
  id:intent.id,idempotency_key:intent.idempotencyKey,candidate_id:intent.opportunityId,decision_id:intent.decisionId,
  environment:'DEMO',symbol:'XAUUSD',direction:'BUY',volume:0.1,stop_loss:1990,take_profit:2020,
  created_at:intent.createdAt,status:'CREATED'
};

test('Supabase repository sends service credentials only in server request headers and persists an intent', async () => {
  let captured;
  const repository = new SupabaseRestRepository({projectUrl:'https://project.supabase.co',serviceRoleKey:'server-secret'},async (url,init) => {
    captured={url:String(url),headers:init.headers,method:init.method,body:JSON.parse(init.body)};
    return new Response(JSON.stringify([row]),{status:201});
  });
  const result = await repository.createIfAbsent(intent);
  assert.equal(result.ok,true);
  if (result.ok) assert.equal(result.value.created,true);
  assert.equal(captured.method,'POST');
  assert.match(captured.url,/execution_intents\?on_conflict=idempotency_key/);
  assert.equal(captured.headers.authorization,'Bearer server-secret');
  assert.equal(captured.body.idempotency_key,intent.idempotencyKey);
});
test('Supabase repository resolves duplicate idempotency keys by lookup instead of blind retry', async () => {
  let postCount=0, getCount=0;
  const repository = new SupabaseRestRepository({projectUrl:'https://project.supabase.co',serviceRoleKey:'server-secret'},async (url,init) => {
    if (init.method === 'POST') { postCount++; return new Response('[]',{status:201}); }
    getCount++; return new Response(JSON.stringify([row]),{status:200});
  });
  const result = await repository.createIfAbsent(intent);
  assert.equal(result.ok,true);
  if (result.ok) assert.equal(result.value.created,false);
  assert.equal(postCount,1);
  assert.equal(getCount,1);
});
test('Supabase runtime settings RPC reports optimistic version conflicts explicitly', async () => {
  const repository = new SupabaseRestRepository({projectUrl:'https://project.supabase.co',serviceRoleKey:'server-secret'},async () => new Response('[]',{status:200}));
  assert.deepEqual(await repository.writeVersioned({scannerEnabled:true},8),{ok:false,errorCode:'ALREADY_EXISTS'});
});
test('Supabase repository rejects insecure remote URL and missing server key', () => {
  assert.throws(()=>new SupabaseRestRepository({projectUrl:'http://remote.example',serviceRoleKey:'secret'}),/HTTPS/);
  assert.throws(()=>new SupabaseRestRepository({projectUrl:'https://project.supabase.co',serviceRoleKey:'  '}),/not configured/);
});

test('Supabase repository persists Telegram recipients and retrieves due outbox rows', async () => {
  const calls=[];
  const repository = new SupabaseRestRepository({projectUrl:'https://project.supabase.co',serviceRoleKey:'server-secret'},async (url,init) => {
    calls.push({url:String(url),method:init.method,body:init.body ? JSON.parse(init.body) : null,headers:init.headers});
    if (String(url).includes('/telegram_chats?on_conflict=chat_id')) return new Response('[]',{status:201});
    if (String(url).includes('/telegram_chats?chat_id=eq.')) return new Response(JSON.stringify([{chat_id:'123',enabled:true}]),{status:200});
    if (String(url).includes('/telegram_chats?enabled=eq.true')) return new Response(JSON.stringify([{chat_id:'123',display_name:'Trading'}]),{status:200});
    if (String(url).includes('/notification_outbox?')) return new Response(JSON.stringify([{id:'44444444-4444-4444-8444-444444444444',chat_id:'123',status:'PENDING'}]),{status:200});
    return new Response('[]',{status:200});
  });
  assert.equal((await repository.upsertTelegramChat({chatId:'123',displayName:'Trading',discoveredAt:'2026-10-16T12:00:00Z'})).ok,true);
  assert.deepEqual(await repository.setTelegramChatEnabled('123',true),{ok:true,value:{updated:true}});
  assert.equal((await repository.listEnabledTelegramChats()).length,1);
  assert.equal((await repository.listPendingNotifications()).length,1);
  assert.ok(calls.some(call=>call.headers.Prefer==='resolution=merge-duplicates,return=representation'));
});
