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

## What you can do from the phone

- **Projects and sessions** — pick a working directory under the gateway's `--roots`, start, resume, switch between and delete sessions, with a live status per session.
- **Chat** — streamed replies with Markdown and code, collapsible thinking and tool calls, image attachments.
- **Control** — send more instructions while Devin works, stop a turn, allow or reject permission requests, change mode, model, thinking level and speed.
- **Review** — changed files, per-file Git diff, and the output of test and other commands run from the Changes screen.
- **Terminal** — a PTY on the VM (shell or the interactive `devin` TUI) for anything the UI does not cover, such as `devin auth login` or MCP setup.
- **Reconnect** — sessions keep running on the VM while the phone is away; reopening the app replays what was missed, and pending approvals wait for you.

## Not supported

- Editing files, a file browser, or any IDE features. Changes are made by Devin CLI; the diff view is read-only.
- Staging, committing or pushing from the Changes screen. Ask Devin in chat or use the terminal.
- Push notifications while the app is closed. Notifications appear only while the app is still alive in the background, and only where the webview implements the Web Notifications API.
- More than one user or VM per gateway. There is one pairing token and one `devin acp` process.
- TLS on the gateway. Traffic is plain WebSocket inside the tailnet, so keep the default bind (localhost + Tailscale IP) and do not put it on a public interface.
- Any integration with Codex or a model API of its own. Everything goes through Devin CLI.

## Verification status

- The full flow (create session, prompt, tool run, approve and reject, diff, stop and follow-up, reload, gateway restart) was run against a logged-in Devin CLI `3000.14` with the web UI in a phone-sized browser on the same machine as the gateway.
- Not yet verified: the Tailscale path from a real phone, and installing and running the APK and IPA that CI builds.
