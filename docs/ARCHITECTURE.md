# Architecture and component contracts

1. Market Data Provider: normalized XAUUSD quotes/candles and broker symbol metadata.
2. Scanner Scheduler: 60-second schedule, manual scan, unique run IDs, no uncontrolled overlap.
3. Technical Analysis Engine: deterministic evidence only; no AI calls and no future data.
4. Adaptive Strategy Selector: selects among tested strategy families based on current market regime.
5. AI Provider Adapter: configurable provider/model, structured response, explicit timeout and health.
6. Decision Coordinator: merges technical evidence and AI assessment; disagreement blocks entry.
7. Risk Manager: computes requested risk and volume from actual symbol specifications; rejects unachievable risk.
8. Execution Engine / MT5 Bridge: durable intent, idempotency, broker confirmation, reconciliation.
9. Trade Manager: manages open positions using deterministic protective rules.
10. Persistence Repository: durable settings, run history, decisions, intents, orders, positions and audit events.
11. Telegram Service: multiple recipients, notification outbox, delivery status and error handling.
12. Dashboard API/UI: Arabic RTL; backend is the source of truth for all statuses.

An AI decision is an analytical input, not an execution authorization. A new order requires fresh valid market data, a current non-conflicting decision, successful risk validation, a verified environment/account, and a persisted execution intent.

Phase 1 declares contracts and foundational rules only. It does not claim to connect MT5, Supabase, Telegram, an AI provider, or a trading UI.
