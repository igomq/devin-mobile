# Devin Mobile

[![CI](https://github.com/igomq/devin-mobile/actions/workflows/ci.yml/badge.svg)](https://github.com/igomq/devin-mobile/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An iPhone, Android and iPad app for controlling [Devin CLI](https://docs.devin.ai/cli) on your own Linux VM over Tailscale.

Devin Mobile is an unofficial community project. It is not affiliated with, endorsed by or supported by Cognition or Devin.

The phone is a chat-first remote control. All AI work and all file changes are done by Devin CLI on the VM. A small gateway runs next to Devin CLI, talks to it through its official Agent Client Protocol (ACP) interface, and keeps sessions running while the phone is away.

```
 phone (Tauri v2 + SvelteKit)  ──WebSocket over Tailscale──▶  gateway (Node)  ──ACP JSON-RPC (stdio)──▶  devin acp
                                                               ├─ git status / diff
                                                               ├─ test runner
                                                               └─ PTY terminals (shell, devin TUI)
```

The repository has two packages:

- [`gateway/`](gateway/README.md) is the VM-side service. It wraps `devin acp` (no TUI scraping), keeps sessions alive while the phone is disconnected, replays history on reconnect, and serves the web UI.
- [`app/`](app/README.md) is the SvelteKit user interface, packaged for iOS, iPadOS and Android with Tauri v2. The app identifier is `me.gomq.devinmobile`.

## Features

### Sessions and projects

- Pick a working directory under the gateway's `--roots`, then start, resume, switch between, end and delete sessions. Each session shows its live status.
- Search sessions. Sessions waiting for your approval are listed first.

### Chat

- Streamed replies with Markdown and syntax-highlighted code, plus collapsible thinking and tool calls.
- Attach images, or paste or drop them into the composer.
- The composer keeps an unsent draft for each session.
- Copy a reply.
- Live elapsed time while Devin works.

### Control

- Send more instructions while Devin works, stop a turn, and allow or reject permission requests. Approval cards show the command or diff Devin wants to run or apply.
- Change the mode, model, thinking level and speed. The model picker lists single models and Fusion (main plus sidekick) pairs separately.

### Review

- A +/− diff summary in the chat header that opens the Changes screen.
- The Changes screen lists changed files with a per-file Git diff, and runs tests or other commands on the VM and shows their output. The gateway detects a test command for npm, pnpm, yarn, bun, Cargo, Go, pytest and Makefile projects, and you can enter your own.

### Terminal

- A PTY on the VM, running either a shell or the interactive `devin` TUI, for anything the UI does not cover, such as `devin auth login` or MCP setup.

### Reconnect

- Sessions keep running on the VM while the phone is away. Reopening the app replays what you missed, and pending approvals wait for you.

### Account and usage

- Your Devin plan and account details as reported by `devin auth status`, token and context usage per session, and a link to the quota and credits page on app.devin.ai.

### Interface

- Layouts for iPhone, Android phones and iPad or Android tablets. On wide screens the session list stays in a collapsible sidebar next to the open session.
- A translucent Liquid Glass-style interface with light, dark and dim themes and a choice of accent colors. It respects the system Reduce Transparency and Reduce Motion settings.
- Hardware keyboard shortcuts on tablets:

  | Shortcut | Action |
  | --- | --- |
  | Cmd/Ctrl+N | New session |
  | Cmd/Ctrl+K | Search sessions |
  | Cmd/Ctrl+, | Settings |
  | Cmd/Ctrl+\ | Toggle the sidebar |
  | Esc | Stop a running turn |

### Not supported

- Editing files, a file browser, or other IDE features. Devin CLI makes the changes, and the diff view is read-only.
- Staging, committing or pushing from the Changes screen. Ask Devin in chat or use the terminal.
- Push notifications while the app is closed. Notifications appear only while the app is still alive in the background, and only where the webview implements the Web Notifications API.
- More than one user or VM per gateway. A gateway has one pairing token and one `devin acp` process.
- TLS on the gateway. Traffic is plain WebSocket inside the tailnet. See [Security](#security).
- Any integration with Codex or a model API of its own. Everything goes through Devin CLI.

## Requirements

On the VM:

- Linux with [Devin CLI](https://docs.devin.ai/cli) installed and logged in.
- Node.js 20 or later and npm. The gateway depends on `node-pty`, a native module. If npm cannot use a prebuilt binary for your platform, it compiles one, which needs Python 3, `make` and a C++ compiler.
- Git, for the Changes screen.
- [Tailscale](https://tailscale.com/download), signed in to the same tailnet as your phone or tablet.

On the phone or tablet:

- Tailscale, signed in to the same tailnet.
- One of the following: an Android device with a 64-bit ARM (arm64) processor, an iPhone or iPad that you can sideload apps onto, or any recent browser.

## Getting started

### Set up the gateway on the VM

1. Install Tailscale on the VM and on your phone, and sign in to the same tailnet on both.
2. Install Devin CLI on the VM and log in:

   ```bash
   devin auth login
   ```

3. Clone the repository, then build the web UI and the gateway. The gateway serves the built web UI from `app/build`.

   ```bash
   git clone https://github.com/igomq/devin-mobile.git
   cd devin-mobile
   (cd app && npm ci && npm run build)
   (cd gateway && npm ci && npm run build)
   ```

4. Start the gateway and print the pairing token:

   ```bash
   node gateway/dist/index.js --print-token
   ```

   By default the gateway listens on port 8787 on `127.0.0.1` and on the VM's Tailscale IPv4 address only. It never binds to all interfaces unless you pass `--host`. The token is generated on first start and stored in `~/.local/share/devin-mobile/token` with mode 0600. Run the command again with `--print-token` whenever you need to see it.

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

1. Get the token on the VM with `node gateway/dist/index.js --print-token`.
2. In the app, enter the gateway address and the token. The address can be `100.x.y.z`, `100.x.y.z:8787`, a MagicDNS name, an `http(s)://` URL or a `ws(s)://…/ws` URL. Without a port, the app uses 8787 for plain `ws://` addresses.

You can also use a pairing link of the form `http://<tailscale-ip>:8787/#token=<token>`. Opening it in a browser connects the web UI directly and removes the token from the address bar. Pasting it into either field in the app fills in both.

The token is stored on the device in app storage. Forgetting the gateway in Settings removes it along with the cached sessions.

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
- Not yet verified: the Tailscale path from a real phone, and installing and running the APK and IPA that CI builds.

## Security

The gateway has no TLS. Traffic between the phone and the VM is plain HTTP and WebSocket, and relies on the tailnet, which is encrypted with WireGuard, for confidentiality. Keep the default bind (localhost and the Tailscale IP) and never expose the gateway on a public interface. The pairing token gives full control of Devin CLI and a shell on the VM as the user that runs the gateway, so treat it like an SSH key.

Your Devin credentials stay on the VM. See [SECURITY.md](SECURITY.md) for the threat model and for how to report a vulnerability privately.

## Contributing

Bug reports, fixes and improvements are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, conventions and pull request process, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Devin Mobile is released under the [MIT License](LICENSE). Copyright (c) 2026 GomQ.
