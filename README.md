# XAUUSD AI Trading Bot

Independent XAUUSD trading system, built from scratch. It does not import or modify GB-V5 or GB-V6.

## Current implementation

- Strict TypeScript domain contracts, explicit opportunity lifecycle, risk sizing and execution-state contracts.
- Closed-candle market normalization and deterministic EMA, RSI, MACD and ATR calculations.
- Authenticated local MT5 bridge in Python, with explicit Demo/Live account matching, independent Live safety gates, and SQLite idempotency ledger.
- Configurable OpenAI-compatible AI assessment adapter; AI responses are analysis only and cannot directly place orders.
- Supabase REST persistence adapters and a single complete schema file with RLS and atomic versioned settings RPC.
- Arabic RTL dashboard with scanner countdown, M1 candlestick chart, technical metrics/evidence, risk settings, Demo/Live environment selection, bot-owned position monitoring/modification/closure, and Telegram multi-chat discovery with a persistent notification outbox when Supabase is configured.
- Historical AI backtesting panel: retrieves closed XAUUSD candles from the authenticated MT5 bridge (up to 5,000 M1 bars plus M5/M15/H1 context), tests the selected allowlisted AI model, models bid/ask spread, slippage and round-turn commission, and reports win rate, net P/L, profit factor, drawdown and individual trades. Backtests never submit orders.
- GitHub Actions runs TypeScript tests and Python bridge safety tests.

## Run the dashboard locally

Requirements: Node.js 22.16 or newer.

```bash
npm ci
npm start
```

Open http://127.0.0.1:3000. The dashboard refuses non-loopback binding because it exposes trade controls and has no public-user authentication layer. Until the bridge and AI are configured, the scanner deliberately returns NOT_READY and does not fabricate signals.

## Connect an MT5 Demo terminal (Windows)

Install the MT5 Python package in the Python environment used by the terminal bridge:

```powershell
py -m pip install -r mt5_bridge/requirements.txt
```

Generate a private bridge token and set the same value in both processes. Example PowerShell commands:

```powershell
$env:MT5_BRIDGE_TOKEN = py -c "import secrets; print(secrets.token_urlsafe(32))"
$env:MT5_BRIDGE_PORT = "8765"
py mt5_bridge/bridge.py
```

In a second PowerShell window, set the token to the same value printed in the first window, then start the dashboard:

```powershell
$env:MT5_BRIDGE_URL = "http://127.0.0.1:8765"
$env:MT5_BRIDGE_TOKEN = "paste-the-same-local-token-here"
$env:AI_BASE_URL = "https://your-openai-compatible-provider/v1"
$env:AI_PROVIDER_ID = "your-provider"
$env:AI_MODEL_ID = "your-model"
$env:AI_API_KEY = "your-secret-key"
npm start
```

The AI key and bridge token are server-side environment variables; never commit them or place them in dashboard code. Keep MetaTrader logged into the account matching the selected environment. The bridge blocks execution unless the connected account matches Demo/Live selection, requires Hedging mode, and applies separate server-side Live gates. It manages only bot-owned positions.

## Database configuration

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the server only. In Supabase SQL Editor, run the complete `supabase/schema.sql` file once on the dedicated project before expecting durable settings. This is the single canonical SQL setup file. RLS is enabled and no browser-facing table policies are created. Never put the service-role key in browser code.

## Validation

```bash
npm ci
npm test
python -m unittest discover -s tests_python -v
```

## Safety boundaries

- Live mode is exposed in the MT5 connection section and settings, but remains locked unless both Render and the MT5 bridge have independent Live gates enabled and the bridge confirms the connected real Hedging account.
- The scanner requires a matching MT5 environment, AI configuration and successful health checks.
- Auto-execution starts disabled and can only be armed after scanner, AI probe, risk settings, Supabase persistence and matching account checks pass. Netting accounts or any unowned XAUUSD position block automation. Stopping the scanner disarms it.
- Analysis decisions are not execution authorization. Execution requires separate risk validation, durable intent persistence, account-environment verification and broker reconciliation.
- Ambiguous MT5 order results are not blindly retried.
- Do not infer profitability from unit tests or architecture completeness.

See `docs/DEMO_RUNBOOK.md`, `docs/PROJECT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/PHASE_1_ACCEPTANCE.md`, `docs/TEST_STRATEGY.md`, and `docs/PHASE_STATUS.md`.


## Demo and Live execution modes

The bridge and dashboard support an explicit execution environment selection. **Demo is the default and Live remains blocked unless independently enabled on both the dashboard host and the machine running MT5.** Selecting Live does not itself arm automated trading; the separate automated-execution action is still required. Automated execution is reset to off after a server restart.

Dashboard host environment variables:
- `LIVE_TRADING_ENABLED=true`
- `LIVE_TRADING_CONFIRMATION=I_UNDERSTAND_LIVE_TRADING_RISK`

MT5 bridge machine environment variables (set separately on the Windows machine that runs the bridge):
- `MT5_LIVE_TRADING_ENABLED=true`
- `MT5_LIVE_CONFIRMATION=I_UNDERSTAND_LIVE_TRADING_RISK`

The bridge starts in Demo mode by default. Keep it bound to loopback; do not expose its port directly to the internet. Render can reach a locally hosted bridge only through an authenticated, encrypted tunnel or a secure private network. Configure `MT5_BRIDGE_URL` to that HTTPS endpoint and retain the matching `MT5_BRIDGE_TOKEN`. The dashboard refuses to switch modes unless the bridge confirms that the actual connected MT5 account matches the requested environment and is execution-ready.

Live mode is not enabled by this code change alone. The two environment gates, matching MT5 real account, a secure bridge route, successful regression tests, and a deliberate confirmation in the dashboard are all required. Historical backtests remain simulations and never submit broker orders.
