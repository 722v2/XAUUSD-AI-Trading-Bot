-- Additive migration for deployments that already applied the initial schema.
alter table public.positions add column if not exists initial_stop_loss numeric(24, 8);
