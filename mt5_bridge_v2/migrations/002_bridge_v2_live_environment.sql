-- Bridge V2 supports a selected Demo or Live terminal environment.
-- Live order submission remains disabled unless MT5_LIVE_TRADING_ENABLED=true on Render
-- and on the Windows agent; existing Demo rows remain unchanged.
alter table public.bridge_agents drop constraint if exists bridge_agents_environment_check;
alter table public.bridge_agents add constraint bridge_agents_environment_check check (environment in ('DEMO','LIVE'));
alter table public.bridge_commands drop constraint if exists bridge_commands_environment_check;
alter table public.bridge_commands add constraint bridge_commands_environment_check check (environment in ('DEMO','LIVE'));
