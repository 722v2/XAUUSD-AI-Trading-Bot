# Local Demo runbook

This is a local Windows + MetaTrader 5 Demo setup guide. The dashboard and MT5 bridge deliberately bind to loopback; do not expose them to the public internet.

## 1. Apply the database migrations

In a dedicated Supabase project, open SQL Editor and apply these files in order:

1. `supabase/migrations/202610160001_phase1_foundation.sql`
2. `supabase/migrations/202610160002_position_initial_stop.sql`

Use the project's server-side `service_role` key only in the dashboard process environment. Never put it in browser code, screenshots, GitHub, or a public Render environment.

## 2. Install the project

Requirements: Node.js 22.16+, Python 3.10+ on Windows, and an installed MetaTrader 5 terminal logged into a **Demo hedging account**.

```powershell
git clone https://github.com/722v2/XAUUSD-AI-Trading-Bot.git
cd XAUUSD-AI-Trading-Bot
npm ci
py -m pip install -r mt5_bridge/requirements.txt
```

## 3. Start the MT5 bridge

In PowerShell window 1, generate a token and retain it privately:

```powershell
$env:MT5_BRIDGE_TOKEN = py -c "import secrets; print(secrets.token_urlsafe(32))"
$env:MT5_BRIDGE_PORT = "8765"
py mt5_bridge/bridge.py
```

Keep this window open. The token printed by the first command is available in that PowerShell session. Copy it privately for the second session; never commit it.

## 4. Start the dashboard

In PowerShell window 2, replace the sample values with your actual server-side credentials:

```powershell
$env:MT5_BRIDGE_URL = "http://127.0.0.1:8765"
$env:MT5_BRIDGE_TOKEN = "paste-the-same-private-token"
$env:AI_PROVIDER_ID = "your-provider"
$env:AI_MODEL_ID = "your-model"
$env:AI_BASE_URL = "https://your-openai-compatible-provider/v1"
$env:AI_API_KEY = "your-provider-secret"
$env:SUPABASE_URL = "https://your-project.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "your-server-only-service-role-key"
npm start
```

Open http://127.0.0.1:3000. The dashboard refuses non-loopback binding by design. A real provider/API credential and a real Supabase project are required for a live integration check; CI fixtures do not verify those external services.

## 5. Safe activation sequence

1. Confirm MT5 shows the intended Demo account and that its account mode is **hedging**. Netting accounts are intentionally blocked from automated execution because position ownership can be ambiguous.
2. Check the dashboard health panel. MT5 must be connected; AI must pass a real assessment; Supabase must be connected.
3. Save risk settings and verify they are persisted.
4. Discover Telegram chats if notifications are needed. Start the bot in Telegram first. Enable only intended recipients.
5. Start the scanner. It checks closed M1 candles every 60 seconds and uses M5/M15/H1 as context. Invalid/stale data should produce NO_ANALYSIS, not a signal.
6. Review scanner history and analysis output before enabling Demo auto-execution.
7. Enable **تفعيل التنفيذ الآلي (Demo)** only when you intend to allow orders on that Demo account. The system checks AI, persisted risk settings, fresh quote, broker specifications and durable intent before sending.
8. Verify every submitted order and position directly in MetaTrader 5, not only in the dashboard.

## 6. Stop and recovery

- Press **إيقاف السكانر** to stop new scans and disarm auto-execution. The bridge will not send Live orders.
- Auto-execution is not persisted as enabled and resets to off after a server restart.
- The server-side SL/TP remains at the broker if the dashboard process stops, but automatic breakeven/trailing updates stop until the service returns.
- If an order result is ambiguous, the system records reconciliation-required state and does not blindly retry. Inspect the MT5 terminal and execution ledger before manual intervention.
- Position management only touches bot-owned positions in the Demo hedging account. It never loosens SL or changes TP. Baseline policy: breakeven at 1R and ATR trailing after 1.5R; these parameters are not performance-validated.
- If Telegram is rate-limited, the durable outbox schedules retries when Supabase is configured.

## 7. Verification commands

```powershell
npm ci
npm test
py -m unittest discover -s tests_python -v
```

Current CI uses mocked MT5/AI/Supabase boundaries. Before calling the system production-ready, perform real Demo open/modify/close and restart-recovery tests, apply and verify the migrations on the target Supabase project, test provider outages and broker timeouts, and run chronological backtests with realistic spread, commissions and slippage. Live trading remains disabled.
