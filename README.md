# uniharn

[![CI](https://github.com/igomq/devin-mobile/actions/workflows/ci.yml/badge.svg)](https://github.com/igomq/devin-mobile/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An open-source multi-harness coding agent platform for iPhone, Android, iPad, and web browsers — control coding agent CLIs on your own Linux VM over Tailscale.

uniharn is an unofficial community open-source project (formerly Devin Mobile). It is not affiliated with, endorsed by, or supported by Cognition/Devin, OpenAI, Anthropic, AWS/Kiro, Google, or any other AI provider.

The client is a chat-first remote control. All AI work and file changes are executed by the coding harnesses installed on your VM. A lightweight gateway runs on the VM, connects to harnesses through Agent Client Protocol (ACP) and structured adapters, and keeps sessions running while your device is away.

```
 client (Tauri v2 + SvelteKit)  ──WebSocket over Tailscale──▶  uniharn gateway (Node)  ──HarnessRegistry──▶  ACP / CLI Harnesses
                                                                ├─ Workspaces & Unified Sessions
                                                                ├─ Git status / diff
                                                                ├─ Test runner
                                                                └─ PTY terminals
```

The repository has two packages:

- [`gateway/`](gateway/README.md) (`uniharn-gateway`) is the VM-side service. It provides a harness-agnostic ACP/adapter layer (`HarnessRegistry`, `DevinHarnessAdapter`, `WorkspaceStore`), keeps sessions alive while clients disconnect, replays history on reconnect, and serves the web UI.
- [`app/`](app/README.md) (`uniharn-app`) is the SvelteKit user interface, packaged for iOS, iPadOS and Android with Tauri v2. The app identifier is `me.gomq.uniharn`.

## Features

### Sessions and projects

- Pick a working directory under the gateway's `--roots`, then start, resume, switch between, end and delete sessions. Each session shows its live status.
- Search sessions. Sessions waiting for your approval are listed first.

### Harnesses

- One app for several coding agents: Devin CLI, OpenAI Codex CLI, Claude Code, OpenCode and Kiro CLI over the Agent Client Protocol, plus any ACP agent you add with its own command, arguments, working directory and environment allowlist. Command Code and Google Antigravity are listed but stay off until they ship an ACP entry point.
- Pick the harness when you start a session. Modes, models and options come from what each agent reports, so every harness shows its own pickers. Missing CLIs show an install hint, and sign-in errors say how to log in.
- See [docs/HARNESSES.md](docs/HARNESSES.md) for tested versions and limits.

### Handoff and subagents

- Hand a session off to another harness. The new session starts in the same directory with the conversation transcript and an optional next instruction.
- Delegate a task to a subagent on any harness, optionally in its own Git worktree so its edits stay off your branch. Subagents appear under their parent session with their status and result, and you get a notification when one finishes.
- Every ACP harness gets a `uniharn` MCP server with `delegate_task`, `list_harnesses` and related tools, so agents can delegate to each other.

### Chat

- Streamed replies with Markdown and syntax-highlighted code, plus collapsible thinking and tool calls.
- Attach images, or paste or drop them into the composer.
- The composer keeps an unsent draft for each session.
- Copy a reply.
- Live elapsed time while the agent works.

### Control

- Send more instructions while the agent works, stop a turn, and allow or reject permission requests. Approval cards show the command or diff the agent wants to run or apply.
- Change the mode, model, thinking level and speed. For Devin the model picker lists single models and Fusion (main plus sidekick) pairs separately.

### Notifications

- In-app banners and a notification center for approvals, finished and failed runs, subagent results, Git conflicts, a lost gateway, and sessions that have waited too long.
- Web Push to browsers and Home Screen PWAs (HTTPS via `tailscale serve`), with per-event switches and lock-screen-safe text. Native FCM/APNs need external setup; see [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md).

### Review

- A +/− diff summary in the chat header that opens the Changes screen.
- The Changes screen has Files, History, Branches, Worktrees, PRs and Runs tabs: stage, unstage and discard, commit and amend, switch and create branches, fetch, pull and push, resolve merge, rebase and cherry-pick conflicts, compare and merge worktrees, and list, view, create and link GitHub PRs through `gh`. Destructive actions ask for confirmation, and force pushes use `--force-with-lease`.
- Runs tests or other commands on the VM and shows their output. The gateway detects a test command for npm, pnpm, yarn, bun, Cargo, Go, pytest and Makefile projects, and you can enter your own.

### Terminal

- A PTY on the VM, running either a shell or the interactive `devin` TUI, for anything the UI does not cover, such as signing in to a harness or MCP setup.

### Reconnect

- Sessions keep running on the VM while the phone is away. Reopening the app replays what you missed, and pending approvals wait for you.

### Account and usage

- Your Devin plan and account details as reported by `devin auth status`, token and context usage per session, and a link to the quota and credits page on app.devin.ai.

### Interface

- Layouts for iPhone, Android phones and iPad or Android tablets. On wide screens the session list stays in a collapsible sidebar next to the open session.
- A translucent Liquid Glass-style interface with code-editor themes: uniharn, Absolutely, Ayu, Catppuccin, Dracula, Everforest, GitHub, Gruvbox and Linear. Themes cover the terminal and syntax colors too. You can search the themes, follow the system light/dark setting and pick any accent color. It respects the system Reduce Transparency, Reduce Motion and Increase Contrast settings. See [docs/themes.md](docs/themes.md).
- Hardware keyboard shortcuts on tablets:

  | Shortcut | Action |
  | --- | --- |
  | Cmd/Ctrl+N | New session |
  | Cmd/Ctrl+K | Search sessions |
  | Cmd/Ctrl+, | Settings |
  | Cmd/Ctrl+\ | Toggle the sidebar |
  | Esc | Stop a running turn |

### Not supported

- Editing files, a file browser, or other IDE features. The agents make the changes.
- Native FCM/APNs push. Web Push works in browsers and Home Screen PWAs; native push needs a Firebase project and an Apple signing team (see [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)).
- More than one user or VM per gateway. All paired devices have the same rights.
- TLS on the gateway. Traffic is plain WebSocket inside the tailnet. See [Security](#security).
- A model API of its own. Every request goes through a harness CLI installed on the VM.

## Requirements

On the VM:

- Linux with at least one harness installed and signed in: [Devin CLI](https://docs.devin.ai/cli), Codex CLI with [`codex-acp`](https://www.npmjs.com/package/@zed-industries/codex-acp), Claude Code with [`claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp), [OpenCode](https://opencode.ai), Kiro CLI, or another ACP agent.
- Node.js 20 or later and npm. The gateway depends on `node-pty`, a native module. If npm cannot use a prebuilt binary for your platform, it compiles one, which needs Python 3, `make` and a C++ compiler.
- Git, for the Changes screen and worktrees, and the GitHub CLI `gh` (signed in) for the PRs tab.
- [Tailscale](https://tailscale.com/download), signed in to the same tailnet as your phone or tablet.

On the phone or tablet:

- Tailscale, signed in to the same tailnet.
- One of the following: an Android device with a 64-bit ARM (arm64) processor, an iPhone or iPad that you can sideload apps onto, or any recent browser.

## Getting started

### Set up the gateway on the VM

1. Install Tailscale on the VM and on your phone, and sign in to the same tailnet on both.
2. Install the harnesses you want on the VM and sign in to each, for example `devin auth login`, `codex login` or `claude /login`. [gateway/README.md](gateway/README.md#harnesses) lists the install command for each.

3. Clone the repository, then build the web UI and the gateway. The gateway serves the built web UI from `app/build`.

   ```bash
   git clone https://github.com/igomq/devin-mobile.git
   cd devin-mobile
   (cd app && npm ci && npm run build)
   (cd gateway && npm ci && npm run build)
   ```

4. Start the gateway:

   ```bash
   node gateway/dist/index.js
   ```

   By default the gateway listens on port 8787 on `127.0.0.1` and on the VM's Tailscale IPv4 address only. It never binds to all interfaces unless you pass `--host`. A master token is generated on first start and stored in `~/.local/share/uniharn/token` with mode 0600; `--print-token` prints it. Pair devices as described in [Pairing](#pairing).

The gateway looks up the Tailscale address once, at startup, by running `tailscale ip -4`. If Tailscale is not up yet, the gateway listens on `127.0.0.1` only. Restart it after Tailscale connects, or pass the address with `--host`.

See [gateway/README.md](gateway/README.md) for all options, including `--roots` to choose which directories the app can open as projects.

### Keep the gateway running

Sessions only keep running while the gateway runs, so start it as a service, or at least inside `tmux`. A systemd user service works well. Save the following as `~/.config/systemd/user/devin-mobile.service`, replacing `/path/to/devin-mobile` with your checkout and `/usr/bin/node` with the output of `command -v node`:

```ini
[Unit]
Description=Devin Mobile gateway
After=network-online.target

[Service]
ExecStart=/usr/bin/node /path/to/devin-mobile/gateway/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Then enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now devin-mobile.service
loginctl enable-linger "$USER"   # keep user services running after you log out
journalctl --user -u devin-mobile.service -f
```

The service runs with systemd's default `PATH`. The gateway finds `devin` in `~/.local/bin`, `/usr/local/bin` or `/opt/homebrew/bin`. If yours is elsewhere, add `Environment=DEVIN_BIN=/full/path/to/devin` to the `[Service]` section.

## Install the app

Download the latest build from the [Releases page](https://github.com/igomq/devin-mobile/releases/latest).

- **Android**: download the APK and install it. Android asks you to allow installs from your browser or file manager the first time. The APK is built for arm64 devices.
- **iOS and iPadOS**: the IPA is unsigned. Sign and install it with [AltStore](https://altstore.io), [SideStore](https://sidestore.io) or [Sideloadly](https://sideloadly.io), or with your own certificate. Apps signed with a free Apple ID expire after seven days and need to be refreshed.
- **Browser**: open `http://<tailscale-ip>:8787` in Safari or Chrome on a device in your tailnet. The gateway serves the same interface. On iOS you can add it to the home screen.

Version 0.2.0 changed the app identifier to `me.gomq.devinmobile`. It installs as a new app next to a 0.1.0 install, so remove the old app.

## Pairing

1. On the VM, run `node gateway/dist/index.js pair`. It prints a one-time code and a QR code for `http://<gateway>/#pair=<CODE>`, valid for 5 minutes (`--ttl 30..900`).
2. In the app, scan the QR code, paste the link or type the code. Opening the link in a browser served by the gateway pairs automatically.

Each device gets its own token. Settings → Devices lists paired devices and can rename or revoke them, rotate this device's token, and pair another device. A revoked device is disconnected immediately. `node gateway/dist/index.js devices list|revoke|revoke-all` does the same from the VM.

You can still connect with the gateway address and the master token under "Use an access token instead". Forgetting the gateway in Settings removes the token along with the cached sessions.

## Development

### Repository layout

```
app/                  SvelteKit UI and Tauri v2 shell
  src/lib/            connection, timeline, formatting and UI state
  src/lib/components/ screens and shared components
  src/routes/         the single page that hosts the app
  src-tauri/          Tauri config, Rust entry point, iOS Info.plist, Android MainActivity.kt
  static/             icon and web manifest
gateway/              VM-side Node service
  src/                WebSocket server, ACP client, sessions, git, tasks, terminals
.github/workflows/    CI and mobile builds
```

### App

```bash
cd app
npm ci
npm run dev      # Vite dev server on http://localhost:5173
npm run check    # svelte-check type checking
npm run build    # static build in app/build
```

When the UI runs from the dev server, enter the address of a running gateway on the connect screen.

Native builds need the Android SDK and NDK, or Xcode on macOS. The `src-tauri/gen` directory is not committed, so generate the platform project once before the first run:

```bash
cd app
npx tauri android init   # or: npx tauri ios init
npx tauri android dev    # or: npx tauri ios dev
```

See [app/README.md](app/README.md) for what the CI build changes in the generated Android project.

### Gateway

```bash
cd gateway
npm ci
npm run dev        # run src/index.ts with tsx
npm run typecheck  # tsc --noEmit
npm run build      # compile to gateway/dist
```

The [CI workflow](.github/workflows/ci.yml) runs `npm run typecheck` and `npm run build` for the gateway, and `npm run check` and `npm run build` for the app, on every pull request and on pushes to `master`.

## Releasing

1. Update the version in `app/src-tauri/tauri.conf.json`, `app/package.json`, `gateway/package.json` and the `VERSION` constant in `gateway/src/index.ts`, and add a `## [X.Y.Z] - YYYY-MM-DD` section to [CHANGELOG.md](CHANGELOG.md).
2. Push a tag named `vX.Y.Z`:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

The [Mobile builds](.github/workflows/mobile.yml) workflow builds the Android APK (`devin-mobile-X.Y.Z-arm64.apk`) and the unsigned iOS IPA (`devin-mobile-X.Y.Z-unsigned.ipa`) and attaches them to a GitHub Release for the tag. The release notes are taken from the matching CHANGELOG.md section, followed by short install instructions. You can also run the workflow by hand from the Actions tab, which produces the builds as workflow artifacts without a release.

By default the APK is signed with a throwaway key generated for each build, so Android refuses to install a new APK over the previous one. To give the APK a stable signature, so that updates install over the previous version, add these repository secrets:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
| `ANDROID_KEY_ALIAS` | The alias of the signing key |
| `ANDROID_KEY_PASSWORD` | The password of the signing key |

## Verification status

- The full flow (create a session, prompt, tool run, approve and reject, diff, stop and follow up, reload, gateway restart) was run against a logged-in Devin CLI 3000.14, with the web UI in a phone-sized browser on the same machine as the gateway.
- OpenCode 1.19.6 ran prompts and a worktree subagent that called the `uniharn` MCP server. Claude Agent ACP 0.23.1 created sessions and switched models. Codex ACP 0.16.0 completed the ACP handshake; prompts were not run because the test VM was not signed in to Codex. Kiro CLI was not tested. See [docs/HARNESSES.md](docs/HARNESSES.md).
- Pairing, device revocation, notifications, themes and the Git screens were run in a phone-sized Chromium against a local gateway.
- Not yet verified: the Tailscale path from a real phone, and installing and running the APK and IPA that CI builds.

## Security

The gateway has no TLS. Traffic between the phone and the VM is plain HTTP and WebSocket, and relies on the tailnet, which is encrypted with WireGuard, for confidentiality. Keep the default bind (localhost and the Tailscale IP) and never expose the gateway on a public interface. A master or device token gives full control of every harness and a shell on the VM as the user that runs the gateway, so treat it like an SSH key, and revoke devices you no longer use.

Harness credentials stay on the VM. See [SECURITY.md](SECURITY.md) for the threat model and for how to report a vulnerability privately.

## Contributing

Bug reports, fixes and improvements are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, conventions and pull request process, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Migrating from Devin Mobile (v0.2.x → v0.3.0 / uniharn)

- **Environment variables**: All `UNIHARN_*` variables (`UNIHARN_HOST`, `UNIHARN_PORT`, `UNIHARN_TOKEN`, `UNIHARN_ROOTS`, `UNIHARN_STATIC`, `UNIHARN_DATA_DIR`) automatically fall back to legacy `DEVIN_MOBILE_*` variables.
- **Gateway token & data directory**: On first start, `uniharn gateway` automatically copies `~/.local/share/devin-mobile/token` to `~/.local/share/uniharn/token` (mode `0600`) if the new token does not exist yet.
- **CLI binary**: Both `uniharn gateway` / `uniharn-gateway` and the legacy `devin-mobile-gateway` alias are provided.
- **Web UI storage**: Existing `devin-mobile.*` `localStorage` keys (connection URL/token, theme, accent, sidebar, drafts) migrate transparently to `uniharn.*`.
- **Native mobile app**: Because the Tauri app identifier changed from `me.gomq.devinmobile` to `me.gomq.uniharn`, the new APK/IPA installs alongside the legacy app. Remove the old app and re-pair once after installing `uniharn`.

## License

uniharn is released under the [MIT License](LICENSE). Copyright (c) 2026 GomQ.
