# XAUUSD AI Trading Bot

Independent XAUUSD trading system, built from scratch. It does not import or modify GB-V5 or GB-V6.

## Current implementation

- Strict TypeScript domain contracts, explicit opportunity lifecycle, risk sizing and execution-state contracts.
- Closed-candle market normalization and deterministic EMA, RSI, MACD and ATR calculations.
- Authenticated local MT5 bridge in Python, with Demo-account enforcement and SQLite idempotency ledger.
- Configurable OpenAI-compatible AI assessment adapter; AI responses are analysis only and cannot directly place orders.
- Supabase REST persistence adapters and initial schema migration with RLS and atomic versioned settings RPC.
- Arabic RTL dashboard, manual/scheduled scanner, risk settings, Demo position monitoring/modification/closure, and Telegram multi-chat discovery with a persistent notification outbox when Supabase is configured.
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

The AI key and bridge token are server-side environment variables; never commit them or place them in dashboard code. Keep MetaTrader logged into a Demo hedging account. The bridge rejects non-Demo accounts, blocks automated execution on ambiguous netting accounts, and refuses Live orders. It manages only bot-owned positions.

## Database configuration

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the server only. Apply the SQL migration in `supabase/migrations/` to a dedicated Supabase project before expecting durable settings. RLS is enabled and no browser-facing table policies are created by this migration.

## Validation

```bash
npm ci
npm test
python -m unittest discover -s tests_python -v
```

## Safety boundaries

- Live trading is disabled and not exposed as a dashboard option.
- The scanner can run only after MT5 Demo and AI are configured and health checks pass.
- Auto-execution starts disabled and can only be armed for Demo after scanner, AI probe, risk settings, Supabase persistence and Demo-account checks pass. Stopping the scanner disarms it.
- Analysis decisions are not execution authorization. Execution requires separate risk validation, durable intent persistence, Demo verification and broker reconciliation.
- Ambiguous MT5 order results are not blindly retried.
- Do not infer profitability from unit tests or architecture completeness.

See `docs/PROJECT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/PHASE_1_ACCEPTANCE.md`, `docs/TEST_STRATEGY.md`, and `docs/PHASE_STATUS.md`.
