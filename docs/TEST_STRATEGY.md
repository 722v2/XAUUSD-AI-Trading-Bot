# Test strategy

- Unit: domain rules, input validation, state transitions and deterministic decision policies.
- Contract: adapter inputs/outputs and explicit error shapes.
- Integration: database, AI provider, Telegram and MT5 bridge when implemented.
- Failure injection: timeouts, stale data, disconnected AI, database failure, bridge restart and ambiguous broker acknowledgements.
- Trading research: chronological backtests, spread/commission/slippage assumptions, out-of-sample evaluation and comparison against a no-AI baseline.
- Demo end-to-end: verified open/modify/close lifecycle, broker reconciliation, no duplicate orders and complete audit trail.

Tests must run and their output must be retained; writing tests alone does not pass a stage.
