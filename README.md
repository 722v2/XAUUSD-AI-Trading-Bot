# XAUUSD AI Trading Bot

An independent, safety-first XAUUSD trading system. The project is built from scratch and is not derived from GB-V5 or GB-V6.

## Current status

- Specification: approved for Phase 1 foundation work.
- Trading execution: not implemented; no live trading.
- MT5 integration: not implemented.
- AI decision engine: not implemented.
- UI: not implemented.
- Phase 1 status: in progress until CI evidence confirms acceptance criteria.

## Locked product decisions

- XAUUSD; M1 entry timing with M5/M15/H1 context.
- Scanner scheduled every 60 seconds plus manual scan.
- Hybrid strategy style leaning toward scalping; balanced opportunity frequency.
- Internal deterministic technical analysis plus an AI decision provider configurable through the UI.
- MT5 is the market-data source; Demo first. Live requires explicit approval and verified safety gates.
- Arabic-first RTL dashboard with separate sections for scanner, analysis/AI, risk/capital, MT5, trades/journal, Telegram, settings and health.
- Risk is user-configurable as either a percentage of reference capital or a fixed cash amount; user sets minimum RR.
- Multiple Telegram chat IDs, discovery where Telegram updates make them available, and per-chat notification controls.
- No claim of profitability or defect-free software without evidence.

## Engineering principles

- Strict domain contracts and explicit state transitions.
- Fail closed for missing security-critical configuration and invalid data.
- No order execution from an AI response alone.
- Idempotent execution intents and broker reconciliation before retrying ambiguous orders.
- No silent persistence failures.
- Tests and CI evidence required before a phase is considered complete.
- No production changes or live trading without explicit user approval.

## Phase plan

1. Foundation
2. Market Data & Analysis
3. Opportunity Lifecycle
4. Risk & Execution
5. AI Decision Engine
6. Persistence & Recovery
7. Dashboard & Telegram
8. Integration, Security & Release

See `docs/PROJECT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/PHASE_1_ACCEPTANCE.md`, and `docs/TEST_STRATEGY.md` for the current specification and acceptance criteria.
