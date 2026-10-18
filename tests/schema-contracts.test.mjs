import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('canonical Supabase schema creates core tables with RLS and no public policies', async () => {
  const sql = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const expectedTables = [
    'app_settings', 'risk_settings', 'ai_provider_configs', 'market_quotes', 'market_bars',
    'scanner_runs', 'strategy_candidates', 'ai_assessments', 'trade_decisions',
    'execution_intents', 'broker_orders', 'positions', 'trade_events', 'telegram_chats',
    'notification_outbox', 'audit_events', 'system_health_events'
  ];
  for (const table of expectedTables) {
    assert.match(sql, new RegExp('create table if not exists public\\.' + table + '\\b', 'i'), table + ' table missing');
    assert.match(sql, new RegExp('alter table public\\.' + table + ' enable row level security', 'i'), table + ' RLS missing');
  }
  assert.match(sql, /idempotency_key text not null unique/i);
  assert.match(sql, /create or replace function public\.write_runtime_settings/i);
  assert.match(sql, /grant execute on function public\.write_runtime_settings\(jsonb, integer\) to service_role/i);
  assert.match(sql, /secret_reference text/i);
  assert.doesNotMatch(sql, /create policy .* to anon/i);
  assert.doesNotMatch(sql, /service_role_key\s*=/i);
});

test('canonical schema risk-mode constraint requires exactly the selected risk value', async () => {
  const sql = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /risk_percent is not null and risk_percent > 0 and risk_cash is null/i);
  assert.match(sql, /risk_cash is not null and risk_cash > 0 and risk_percent is null/i);
});

test('canonical schema stores original stop for trailing recovery', async () => {
  const sql = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /initial_stop_loss numeric\(24, 8\)/i);
});
