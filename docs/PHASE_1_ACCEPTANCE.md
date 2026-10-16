# Phase 1 — Foundation acceptance criteria

Phase 1 is complete only when every required criterion is demonstrated by CI evidence.

- [ ] Clean checkout installs dependencies with `npm ci` using the committed lockfile.
- [ ] TypeScript strict typecheck passes.
- [ ] Build passes.
- [ ] Tests pass from built output.
- [ ] Analysis, AI decision, risk, execution intent, order and position concepts remain distinct.
- [ ] Opportunity state machine rejects undeclared transitions.
- [ ] Risk settings validate percentage and fixed-cash modes without application-defined risk caps/floors.
- [ ] Missing security-critical secrets fail closed.
- [ ] Persistence contracts represent failures explicitly.
- [ ] Pipeline skeleton returns explicit NOT_READY until later phases implement it.
- [ ] CI runs on feature branch pushes and pull requests to main.
- [ ] No live trading, fake market signals, hard-coded credentials or production integrations are present.

Initial test inventory: state transitions; percentage and fixed-cash risk; invalid capital/risk/RR; fail-closed secret readiness; explicit not-ready pipeline; in-process duplicate idempotency helper; versioned runtime configuration.

Passing Phase 1 does not establish strategy profitability or MT5 execution safety.
