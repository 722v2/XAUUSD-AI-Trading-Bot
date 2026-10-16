# Phase status and release gates

Updated: 2026-10-16

## Phase 1 — Foundation
- Implemented strict domain contracts, versioned in-memory runtime config, persistence interfaces, secret readiness and opportunity state transitions.
- Supabase initial schema migration is present; it has not been applied to a real project in this repository workflow.
- Integrated GitHub Actions passed on the current implementation: 51 Node.js tests and 14 Python bridge tests, with 0 failures.

## Phase 2 — Market Data & Analysis
- Implemented quote/candle normalization, closed-bar validation, EMA, RSI, MACD and ATR, and an M1 deterministic candidate analyzer.
- M5/M15/H1 closed bars are retrieved for context; current signal rules remain a baseline and have not been validated by backtesting.
- Stale data, invalid OHLC, open bars, duplicates, out-of-order bars and insufficient history fail closed.

## Phase 3 — Opportunity Lifecycle
- Implemented candidate deduplication, explicit state-transition rules, expiry, and persisted candidate/assessment/decision/trade-event records when Supabase is configured.
- The pure opportunity state machine remains separately tested; the broker/database recovery path is covered by contract tests and still requires real terminal restart verification.

## Phase 4 — Risk & Execution Contracts
- Implemented broker-spec-based position sizing and RR/geometry checks.
- Added Demo-only intent preparation, durable intent persistence, and a local bridge that refuses ambiguous retries.
- Added deterministic break-even and ATR-trailing stop management that never loosens SL or changes TP; open positions are reconciled and persisted. Unowned XAUUSD positions block automated management and new entries, and the scanner permits at most one bot-owned XAUUSD position at a time.
- This is not yet proof of real-terminal MT5 order execution.

## Phase 5 — AI Decision Engine
- Implemented OpenAI-compatible structured assessment adapter and a conflict policy that blocks disagreement.
- Dashboard provider/model selection is restricted to a server-side allowlist; API keys remain server environment secrets and selections can be persisted through Supabase.
- API connectivity has not been verified against an actual provider credential in this repository workflow.

## Phase 6 — Persistence & Recovery
- Implemented a server-side Supabase REST repository for execution-intent idempotency, unresolved-intent recovery, position persistence, optimistic runtime settings, Telegram chat persistence and notification outbox retries.
- Added SQL migrations for the core schema, RLS and atomic versioned runtime settings.
- A real Supabase project must be configured and all migrations applied before durable persistence is operational.

## Phase 7 — Dashboard & Telegram
- Implemented an Arabic RTL responsive dashboard, readiness API, risk form, allowlisted AI provider/model selector, manual scan, 60-second scanner toggle, scan log, live bot-position table with SL/TP/close controls, and Telegram discovery/test-message controls.
- Telegram recipients and notifications use the Supabase chat table and outbox when Supabase is configured. Failed deliveries are retried according to stored retry time; without Supabase, chat selection remains process-local.
- Dashboard reports missing dependencies rather than fabricating connected status or signals.

## Phase 8 — Integration, Security & Release
- Implemented a local Python MT5 bridge with token authentication, loopback-only binding, Demo-account enforcement, closed-candle retrieval, broker symbol specifications, order validation, SQLite idempotency, and bot-owned position monitoring/modification/closure.
- TypeScript bridge client is implemented; Demo auto-execution is gated behind explicit UI opt-in, a Demo hedging account, fresh quotes, risk validation, persisted intent and an AI connectivity probe.
- Automatic management tightens stops at 1R and trails after 1.5R using 1.2 ATR; it never loosens SL or moves TP. These baseline thresholds require strategy/backtest evaluation before any production use.
- **External validation still pending:** real terminal Demo end-to-end verification, actual AI provider credentials, applying the Supabase migrations to a real project, and verifying restart recovery against a real broker/terminal before any release deployment.
- Live trading remains disabled.

## Release gate
Do not label the bot production-ready until clean CI passes, Supabase is configured and tested, MT5 Demo open/modify/close and restart-recovery tests pass, duplicate orders are prevented under failure injection, AI outages fail closed, and the full audit trail is verified.
