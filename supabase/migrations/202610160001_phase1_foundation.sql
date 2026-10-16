-- Phase 1 foundational schema. No credentials/secrets are stored in these tables.
-- All tables use RLS with no browser-facing policies by default; backend access is added deliberately later.

create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  setting_key text primary key,
  setting_value jsonb not null,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.risk_settings (
  scope text primary key default 'global',
  mode text not null check (mode in ('PERCENT_OF_CAPITAL', 'FIXED_CASH')),
  reference_capital numeric(24, 8) not null check (reference_capital > 0),
  risk_percent numeric(12, 6),
  risk_cash numeric(24, 8),
  minimum_rr numeric(12, 6) not null check (minimum_rr >= 0),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  constraint risk_mode_fields_valid check (
    (mode = 'PERCENT_OF_CAPITAL' and risk_percent is not null and risk_percent > 0 and risk_cash is null)
    or
    (mode = 'FIXED_CASH' and risk_cash is not null and risk_cash > 0 and risk_percent is null)
  )
);

create table if not exists public.ai_provider_configs (
  provider_id text primary key,
  model_id text,
  settings jsonb not null default '{}'::jsonb,
  secret_reference text,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.market_quotes (
  id uuid primary key default gen_random_uuid(),
  symbol text not null default 'XAUUSD' check (symbol = 'XAUUSD'),
  bid numeric(24, 8) not null check (bid > 0),
  ask numeric(24, 8) not null check (ask >= bid),
  tick_time timestamptz not null,
  received_at timestamptz not null default now()
);
create index if not exists market_quotes_tick_time_idx on public.market_quotes (symbol, tick_time desc);

create table if not exists public.market_bars (
  id bigserial primary key,
  symbol text not null default 'XAUUSD' check (symbol = 'XAUUSD'),
  timeframe text not null check (timeframe in ('M1', 'M5', 'M15', 'H1')),
  open_time timestamptz not null,
  close_time timestamptz not null check (close_time > open_time),
  open_price numeric(24, 8) not null check (open_price > 0),
  high_price numeric(24, 8) not null check (high_price > 0),
  low_price numeric(24, 8) not null check (low_price > 0),
  close_price numeric(24, 8) not null check (close_price > 0),
  tick_volume bigint not null default 0 check (tick_volume >= 0),
  is_closed boolean not null,
  inserted_at timestamptz not null default now(),
  unique (symbol, timeframe, open_time),
  check (high_price >= greatest(open_price, close_price, low_price)),
  check (low_price <= least(open_price, close_price, high_price))
);
create index if not exists market_bars_lookup_idx on public.market_bars (symbol, timeframe, open_time desc);

create table if not exists public.scanner_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_type text not null check (trigger_type in ('SCHEDULED', 'MANUAL')),
  scheduled_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED')),
  candidates_found integer not null default 0 check (candidates_found >= 0),
  candidates_rejected integer not null default 0 check (candidates_rejected >= 0),
  error_code text,
  correlation_id text not null unique
);
create index if not exists scanner_runs_started_idx on public.scanner_runs (started_at desc);

create table if not exists public.strategy_candidates (
  id uuid primary key default gen_random_uuid(),
  scanner_run_id uuid references public.scanner_runs(id),
  candidate_key text not null unique,
  strategy_id text not null,
  symbol text not null default 'XAUUSD' check (symbol = 'XAUUSD'),
  direction text not null check (direction in ('BUY', 'SELL')),
  entry_price numeric(24, 8) not null check (entry_price > 0),
  stop_loss numeric(24, 8) not null check (stop_loss > 0),
  take_profit numeric(24, 8) not null check (take_profit > 0),
  evidence jsonb not null default '[]'::jsonb,
  status text not null check (status in ('DETECTED', 'ANALYZING', 'AI_PENDING', 'DECIDED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists strategy_candidates_created_idx on public.strategy_candidates (created_at desc);

create table if not exists public.ai_assessments (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.strategy_candidates(id),
  provider_id text not null,
  model_id text not null,
  outcome text not null check (outcome in ('BUY', 'SELL', 'WAIT', 'REJECT')),
  rationale text not null,
  rationale_codes jsonb not null default '[]'::jsonb,
  assessed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  error_code text
);
create index if not exists ai_assessments_candidate_idx on public.ai_assessments (candidate_id, assessed_at desc);

create table if not exists public.trade_decisions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.strategy_candidates(id),
  ai_assessment_id uuid references public.ai_assessments(id),
  technical_outcome text not null check (technical_outcome in ('BUY', 'SELL', 'WAIT', 'REJECT')),
  ai_outcome text not null check (ai_outcome in ('BUY', 'SELL', 'WAIT', 'REJECT')),
  outcome text not null check (outcome in ('BUY', 'SELL', 'WAIT', 'REJECT')),
  reason_codes jsonb not null default '[]'::jsonb,
  decided_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists trade_decisions_candidate_idx on public.trade_decisions (candidate_id, decided_at desc);

create table if not exists public.execution_intents (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  candidate_id uuid not null references public.strategy_candidates(id),
  decision_id uuid not null references public.trade_decisions(id),
  environment text not null check (environment in ('DEMO', 'LIVE')),
  symbol text not null default 'XAUUSD' check (symbol = 'XAUUSD'),
  direction text not null check (direction in ('BUY', 'SELL')),
  volume numeric(24, 8) not null check (volume > 0),
  stop_loss numeric(24, 8) not null check (stop_loss > 0),
  take_profit numeric(24, 8) not null check (take_profit > 0),
  status text not null check (status in ('CREATED', 'SUBMITTED', 'CONFIRMED', 'REJECTED', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists execution_intents_status_idx on public.execution_intents (status, created_at);

create table if not exists public.broker_orders (
  id uuid primary key default gen_random_uuid(),
  execution_intent_id uuid not null references public.execution_intents(id),
  account_login text not null,
  broker_order_id text,
  status text not null,
  request_payload jsonb not null,
  response_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_login, broker_order_id)
);

create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  account_login text not null,
  broker_position_id text not null,
  symbol text not null default 'XAUUSD' check (symbol = 'XAUUSD'),
  direction text not null check (direction in ('BUY', 'SELL')),
  volume numeric(24, 8) not null check (volume > 0),
  entry_price numeric(24, 8) not null check (entry_price > 0),
  stop_loss numeric(24, 8),
  take_profit numeric(24, 8),
  status text not null check (status in ('OPEN', 'CLOSED', 'UNKNOWN', 'RECONCILIATION_REQUIRED')),
  opened_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (account_login, broker_position_id)
);

create table if not exists public.trade_events (
  id uuid primary key default gen_random_uuid(),
  position_id uuid references public.positions(id),
  execution_intent_id uuid references public.execution_intents(id),
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists trade_events_occurred_idx on public.trade_events (occurred_at desc);

create table if not exists public.telegram_chats (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null unique,
  display_name text,
  enabled boolean not null default false,
  subscriptions jsonb not null default '{}'::jsonb,
  discovered_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  chat_id text not null references public.telegram_chats(chat_id),
  message_type text not null,
  payload jsonb not null,
  status text not null check (status in ('PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD_LETTER')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now()
);
create index if not exists notification_outbox_pending_idx on public.notification_outbox (status, next_attempt_at);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  correlation_id text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists audit_events_occurred_idx on public.audit_events (occurred_at desc);

create table if not exists public.system_health_events (
  id uuid primary key default gen_random_uuid(),
  service text not null,
  state text not null check (state in ('HEALTHY', 'DEGRADED', 'DISCONNECTED', 'NOT_CONFIGURED')),
  reason_code text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists system_health_events_occurred_idx on public.system_health_events (occurred_at desc);

-- Browser clients receive no direct table access by default. Add narrow policies only when auth is designed.
alter table public.app_settings enable row level security;
alter table public.risk_settings enable row level security;
alter table public.ai_provider_configs enable row level security;
alter table public.market_quotes enable row level security;
alter table public.market_bars enable row level security;
alter table public.scanner_runs enable row level security;
alter table public.strategy_candidates enable row level security;
alter table public.ai_assessments enable row level security;
alter table public.trade_decisions enable row level security;
alter table public.execution_intents enable row level security;
alter table public.broker_orders enable row level security;
alter table public.positions enable row level security;
alter table public.trade_events enable row level security;
alter table public.telegram_chats enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.audit_events enable row level security;
alter table public.system_health_events enable row level security;


-- Atomic optimistic update for the single versioned runtime configuration document.
create or replace function public.write_runtime_settings(p_settings jsonb, p_expected_version integer)
returns table(version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version integer;
begin
  if p_expected_version < 0 or p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    return;
  end if;

  insert into public.app_settings (setting_key, setting_value, version, updated_at)
  values ('runtime_config', p_settings, 1, now())
  on conflict (setting_key) do update
    set setting_value = excluded.setting_value,
        version = public.app_settings.version + 1,
        updated_at = now()
    where public.app_settings.version = p_expected_version
  returning public.app_settings.version into v_version;

  if not found then
    return;
  end if;
  return query select v_version;
end;
$$;

revoke all on function public.write_runtime_settings(jsonb, integer) from public;
revoke all on function public.write_runtime_settings(jsonb, integer) from anon;
revoke all on function public.write_runtime_settings(jsonb, integer) from authenticated;
grant execute on function public.write_runtime_settings(jsonb, integer) to service_role;
