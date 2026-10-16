# Phase 1 — Foundation acceptance criteria

Phase 1 is complete only when every required criterion is demonstrated by CI evidence.

- [x] Clean checkout installs dependencies with `npm ci` using the committed lockfile.
- [x] TypeScript strict typecheck passes.
- [x] Build passes.
- [x] Tests pass from built output.
- [x] Analysis, AI decision, risk, execution intent, order and position concepts remain distinct.
- [x] Opportunity state machine rejects undeclared transitions.
- [x] Risk settings validate percentage and fixed-cash modes without application-defined risk caps/floors.
- [x] Missing security-critical secrets fail closed.
- [x] Persistence contracts represent failures explicitly.
- [x] Foundational Supabase migration defines core tables, idempotency constraints, risk-mode constraints and RLS without public policies.
- [x] Pipeline skeleton returns explicit NOT_READY until later phases implement it.
- [x] CI runs on feature branch pushes and pull requests to main.
- [x] No live trading or hard-coded credentials are enabled; unimplemented components fail closed and the pipeline never fabricates market signals.

Initial test inventory: state transitions; percentage and fixed-cash risk; invalid capital/risk/RR and risk modes; fail-closed secret readiness; explicit not-ready pipeline; in-process duplicate idempotency helper; versioned runtime configuration; SQL schema/RLS contracts. Current integrated CI additionally covers market analysis, AI adapter contracts, Supabase REST operations, dashboard safety APIs, Telegram rate limiting/outbox contracts, and the local MT5 bridge's Demo-only/idempotency rules.

Passing Phase 1 does not establish strategy profitability or MT5 execution safety.
