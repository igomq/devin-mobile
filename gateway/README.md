# devin-mobile-gateway

Lightweight VM-side service that runs **one long-lived `devin acp` process** (Devin CLI's official
[Agent Client Protocol](https://agentclientprotocol.com/) server, JSON-RPC over stdio) and exposes it to
the mobile app over a single authenticated WebSocket (`/ws`).

- Sessions: `session/new`, `session/load` (history replay), `session/list`, `session/close`, `session/delete`
- Turns: `session/prompt` (streamed `session/update`s), `session/cancel`, `session/request_permission` round-trip
- Controls: `session/set_config_option` (model, reasoning, mode, …), `session/set_mode`
- Extras: git status/diff, test runner, PTY terminals (shell or interactive `devin`), all surviving client disconnects
- Every session update gets a sequence number; clients reconnect with `{epoch, sinceSeq}` and receive only what they missed.

```bash
npm ci && npm run build
node dist/index.js --print-token          # binds 127.0.0.1 (+ Tailscale IPv4 if present), port 8787
```

Options (flag / env): `--port` `DEVIN_MOBILE_PORT`, `--host` `DEVIN_MOBILE_HOST` (comma list),
`--roots` `DEVIN_MOBILE_ROOTS`, `--devin` `DEVIN_BIN`, `--model` `DEVIN_MOBILE_MODEL`,
`--static` `DEVIN_MOBILE_STATIC` (`none` to disable serving the web UI), `DEVIN_MOBILE_TOKEN`.
The pairing token is stored in `~/.local/share/devin-mobile/token` (mode 0600).
