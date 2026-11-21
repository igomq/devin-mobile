# devin-mobile

Codex Mobile-style iOS/Android client for controlling [Devin CLI](https://docs.devin.ai/cli) on a remote Linux VM.
The phone is a chat-first remote control; all AI work and file changes are done by Devin CLI on the VM.

```
 phone (Tauri v2 + SvelteKit)  ──WebSocket over Tailscale──▶  gateway (Node)  ──ACP JSON-RPC (stdio)──▶  devin acp
                                                               ├─ git status / diff
                                                               ├─ test runner
                                                               └─ PTY terminals (shell, devin TUI)
```

- `gateway/` — VM-side service. Wraps the official `devin acp` interface (no TUI scraping), keeps sessions alive while the phone is away, replays history on reconnect. See [gateway/README.md](gateway/README.md).
- `app/` — SvelteKit UI (sessions, streaming chat, approvals, model/mode, changes & diff, tests, terminal) packaged with Tauri v2.

## Quick start (VM)

1. Install [Tailscale](https://tailscale.com/download) on the VM and your phone, and sign in to the same tailnet.
2. Install and log in to Devin CLI on the VM: `devin auth login`.
3. Run the gateway:
   ```bash
   cd app && npm install && npm run build && cd ..
   cd gateway && npm install && npm run build
   node dist/index.js            # binds 127.0.0.1 + the Tailscale IP only, port 8787
   node dist/index.js --print-token
   ```
   Keep it running with systemd/tmux so work continues while your phone is offline.
4. On the phone open the app (or `http://<tailscale-ip>:8787` in a browser), enter `<tailscale-ip>:8787` and the token.

No port is exposed on public interfaces by default. The token lives in `~/.local/share/devin-mobile/token` (mode 0600) and is stored on the phone in app storage.

## Mobile builds

[`.github/workflows/mobile.yml`](.github/workflows/mobile.yml) builds on every PR:

- **Android** — debug-signed APK (`devin-mobile-android-apk` artifact), sideload directly.
- **iOS** — unsigned IPA (`devin-mobile-ios-unsigned-ipa` artifact); sign/sideload with AltStore, Sideloadly or your own certificate.

Local dev: `cd app && npx tauri android dev` / `npx tauri ios dev` (needs Android SDK+NDK / Xcode).
