# MT5 Bridge V2 — outbound-only agent

This is a clean replacement design for the legacy relay. It uses HTTPS requests initiated by Windows; no ngrok, Cloudflare Tunnel, inbound port forwarding, or public Windows listener is required.

## Locked safety and data boundaries
- Biquote is preferred for scanner candles; when it returns stale/unavailable data, the scanner can use fresh closed candles published by this outbound agent.
- This V2 agent remains Demo-only. Live execution is not enabled by this data-feed change.
- A timeout after a broker submission is an UNKNOWN result; never resubmit automatically.
- A durable local SQLite outbox retains results until the server acknowledges them.
- Secrets are loaded from the project-root `.env`, never logged or committed.
- Server-side command storage and heartbeat persistence must be durable before production rollout.

## Implemented protocol
- `POST /api/bridge/v1/heartbeat`
- `GET /api/bridge/v1/commands/next?agentId=...`
- `POST /api/bridge/v1/market/candles` (closed M1/M5/M15/H1 snapshots)
- `POST /api/bridge/v1/commands/:id/result`

## Deployment gate
Do not enable execution until the Render routes, durable repository/migrations, agent, tests, and UI readiness status are integrated and verified end-to-end. The existing bridge remains unchanged until that gate passes.


## Demo and Live environment selection

The rebuilt agent accepts `MT5_EXECUTION_ENVIRONMENT=DEMO` or `LIVE` and verifies that the connected MT5 account's trade mode matches that selection. Use a distinct `MT5_AGENT_ID` for each terminal/environment so a Demo agent cannot overwrite a Live agent's heartbeat or candle snapshot.

Live order execution is **disabled by default**. Leave `MT5_LIVE_TRADING_ENABLED=false` (or unset) in both the Windows agent `.env` and Render environment variables. Live order commands are rejected unless the flag is explicitly set to `true` on both sides. This flag is not set by this code change, and no Live order has been sent.

Before using Live:
1. Apply `migrations/002_bridge_v2_live_environment.sql` to the project's Supabase database.
2. Configure the Live terminal with a unique `MT5_AGENT_ID`, set `MT5_EXECUTION_ENVIRONMENT=LIVE`, and verify the terminal is logged into the intended account.
3. Keep `MT5_LIVE_TRADING_ENABLED=false` until separate explicit approval and a supervised end-to-end test.
4. Confirm the Render status reports the same environment and a fresh heartbeat.

The scanner still prefers Biquote. Bridge V2 candles are a fallback and do not enable trading.
