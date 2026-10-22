# MT5 Bridge V2 — outbound-only agent

This is a clean replacement design for the legacy relay. It uses HTTPS requests initiated by Windows; no ngrok, Cloudflare Tunnel, inbound port forwarding, or public Windows listener is required.

## Locked safety and data boundaries
- Biquote remains the scanner's candle source. This agent is execution/health only.
- Demo-only in the initial rebuild. Live execution is rejected in configuration.
- A timeout after a broker submission is an UNKNOWN result; never resubmit automatically.
- A durable local SQLite outbox retains results until the server acknowledges them.
- Secrets are loaded from the project-root `.env`, never logged or committed.
- Server-side command storage and heartbeat persistence must be durable before production rollout.

## Planned protocol
- `POST /api/bridge/v1/heartbeat`
- `GET /api/bridge/v1/commands/next?agentId=...`
- `POST /api/bridge/v1/commands/:id/ack`
- `POST /api/bridge/v1/commands/:id/result`
- `POST /api/bridge/v1/reconciliation`

## Deployment gate
Do not enable execution until the Render routes, durable repository/migrations, agent, tests, and UI readiness status are integrated and verified end-to-end. The existing bridge remains unchanged until that gate passes.
