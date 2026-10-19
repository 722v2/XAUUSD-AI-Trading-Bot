import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBotClient, TelegramClientError } from '../dist/index.js';

test('Telegram client discovers and deduplicates chats without exposing token', async () => {
  let requestUrl = '';
  const client = new TelegramBotClient('bot-secret',async (url,init) => {
    requestUrl=String(url);
    return new Response(JSON.stringify({ok:true,result:[
      {update_id:10,message:{chat:{id:123,type:'private',first_name:'Fahd',username:'fahd'}}},
      {update_id:11,message:{chat:{id:-100,type:'supergroup',title:'Trading'}}},
      {update_id:12,callback_query:{message:{chat:{id:123,type:'private',first_name:'Fahd'}}}}
    ]}),{status:200});
  });
  const chats = await client.discoverChats('2026-10-16T12:00:00Z');
  assert.equal(chats.length,2);
  assert.equal(chats.find(x=>x.chatId==='123').title,'Fahd');
  assert.equal(requestUrl.includes('bot-secret'),true);
  assert.equal(JSON.stringify(chats).includes('bot-secret'),false);
});
test('Telegram /start automatically discovers the chat and sends a welcome message', async () => {
  const calls=[];
  const client = new TelegramBotClient('bot-secret',async (url,init) => {
    const method=String(url).split('/').pop();
    calls.push({method,payload:JSON.parse(init.body)});
    if (method==='getUpdates') return new Response(JSON.stringify({ok:true,result:[{update_id:9001,message:{text:'/start',chat:{id:123,type:'private',first_name:'Demo User'}}}]}),{status:200});
    return new Response(JSON.stringify({ok:true,result:{message_id:12}}),{status:200});
  });
  const chats=await client.discoverChats('2026-10-19T12:00:00Z');
  assert.equal(chats.length,1);
  assert.equal(chats[0].chatId,'123');
  assert.deepEqual(calls.map(call=>call.method),['getUpdates','sendMessage']);
  assert.match(calls[1].payload.text,/تم الاتصال بنجاح/);
  assert.equal(calls[1].payload.chat_id,'123');
});
test('Telegram client sends messages and handles 429 retry-after safely', async () => {
  const client = new TelegramBotClient('token',async (url,init) => {
    if (String(url).endsWith('/sendMessage')) return new Response(JSON.stringify({ok:false,error_code:429,description:'Too Many Requests',parameters:{retry_after:17}}),{status:429});
    return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});
  });
  await assert.rejects(client.sendMessage('123','test'),e=>e instanceof TelegramClientError && e.code==='RATE_LIMITED' && e.retryAfterSeconds===17);
});
test('Telegram client fails closed when not configured', async () => {
  const client = new TelegramBotClient(undefined,async () => new Response('{}'));
  await assert.rejects(client.discoverChats(),e=>e instanceof TelegramClientError && e.code==='NOT_CONFIGURED');
});
