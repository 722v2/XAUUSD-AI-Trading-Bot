# Phase status and release gates

Updated: 2026-10-16

## Phase 1 — Foundation
- Implemented strict domain contracts, versioned in-memory runtime config, persistence interfaces, secret readiness and opportunity state transitions.
- Supabase initial schema migration is present; it has not been applied to a real project in this repository workflow.
- CI previously passed the Phase 1-only baseline. Later phases are still undergoing integrated CI.

## Phase 2 — Market Data & Analysis
- Implemented quote/candle normalization, closed-bar validation, EMA, RSI, MACD and ATR, and an M1 deterministic candidate analyzer.
- M5/M15/H1 closed bars are retrieved for context; current signal rules remain a baseline and have not been validated by backtesting.
- Stale data, invalid OHLC, open bars, duplicates, out-of-order bars and insufficient history fail closed.

## Phase 3 — Opportunity Lifecycle
- Implemented in-memory opportunity deduplication, versioned state transitions, event history and expiry.
- Durable lifecycle event persistence is still required for restart-safe operation.

## Phase 4 — Risk & Execution Contracts
- Implemented broker-spec-based position sizing and RR/geometry checks.
- Added Demo-only intent preparation and a safe submission port that reconciles ambiguous results rather than blindly retrying.
- This is not yet proof of live MT5 order execution.

## Phase 5 — AI Decision Engine
- Implemented OpenAI-compatible structured assessment adapter and a conflict policy that blocks disagreement.
- API connectivity has not been verified against an actual provider credential in this repository workflow.

## Phase 6 — Persistence & Recovery
- Implemented a server-side Supabase REST repository for execution-intent idempotency and optimistic runtime settings.
- Added a SQL RPC for atomic versioned runtime settings.
- A real Supabase project must be configured and the migration applied before durable persistence is operational.

## Phase 7 — Dashboard & Telegram
- Implemented an Arabic RTL responsive dashboard, readiness API, risk form, manual scan, 60-second scanner toggle, scan log and Telegram discovery/test-message controls.
- Telegram chat selections and scan history are currently process-local; durable outbox and chat persistence remain release work.
- Dashboard reports missing dependencies rather than fabricating connected status or signals.

## Phase 8 — Integration, Security & Release
- Implemented a local Python MT5 bridge with token authentication, loopback default binding, Demo-account enforcement, closed-candle retrieval, broker symbol specifications, order validation and SQLite idempotency ledger.
- TypeScript bridge client is implemented.
- **Not complete:** real terminal Demo end-to-end verification, actual AI provider connectivity, Supabase migration execution, durable trade/position reconciliation, release deployment and full order lifecycle testing.
- Live trading remains disabled.

## Release gate
Do not label the bot production-ready until clean CI passes, Supabase is configured and tested, MT5 Demo open/modify/close and restart-recovery tests pass, duplicate orders are prevented under failure injection, AI outages fail closed, and the full audit trail is verified.
