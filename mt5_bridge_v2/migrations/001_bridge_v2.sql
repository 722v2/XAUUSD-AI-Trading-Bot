create table if not exists public.bridge_agents (
  agent_id text primary key,
  state text not null check (state in ('STARTING','CONNECTED','DEGRADED','DISCONNECTED')),
  environment text not null check (environment = 'DEMO'),
  terminal_connected boolean not null default false,
  account_connected boolean not null default false,
  execution_ready boolean not null default false,
  broker_symbol text,
  account_login text,
  last_error_code text,
  last_seen_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);
create table if not exists public.bridge_commands (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.bridge_agents(agent_id),
  idempotency_key text not null unique,
  kind text not null check (kind = 'EXECUTE_ORDER'),
  environment text not null check (environment = 'DEMO'),
  status text not null check (status in ('PENDING','CLAIMED','SUBMITTING','FILLED','REJECTED','UNKNOWN','EXPIRED')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb
);
create index if not exists bridge_commands_agent_pending_idx on public.bridge_commands(agent_id,status,created_at);
create table if not exists public.bridge_command_results (
  command_id uuid primary key references public.bridge_commands(id),
  idempotency_key text not null unique,
  state text not null check (state in ('FILLED','REJECTED','UNKNOWN','EXPIRED')),
  code text not null,
  details jsonb not null default '{}'::jsonb,
  completed_at timestamptz not null,
  received_at timestamptz not null default now()
);
alter table public.bridge_agents enable row level security;
alter table public.bridge_commands enable row level security;
alter table public.bridge_command_results enable row level security;
-- Access is server-only via the Supabase service-role credential. No client policies are created.
