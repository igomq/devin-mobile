# Contributing to Devin Mobile

Thanks for helping. This document covers the development setup, the layout of the code, the conventions the project follows, and how changes get reviewed and merged.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need Node.js 20 or later and npm. The CI workflow uses Node.js 22. To work on the gateway against a real agent you also need Devin CLI, logged in, on the same machine.

```bash
git clone https://github.com/igomq/uniharn.git
cd uniharn
(cd app && npm ci)
(cd gateway && npm ci)
```

Run the gateway and the UI in two terminals:

```bash
cd gateway && npm run dev -- --print-token   # gateway on port 8787
cd app && npm run dev                        # UI on http://localhost:5173
```

Open http://localhost:5173 and enter `127.0.0.1:8787` and the printed token. To test the UI the way the gateway serves it, run `npm run build` in `app/` and open http://127.0.0.1:8787 instead.

Native builds need the Android SDK and NDK, or Xcode on macOS, plus a Rust toolchain. Generate the platform project with `npx tauri android init` or `npx tauri ios init` in `app/`, then run `npx tauri android dev` or `npx tauri ios dev`. The generated `app/src-tauri/gen` directory is ignored by Git.

## Project structure

- `gateway/src/` holds the VM-side service. `index.ts` is the HTTP and WebSocket server and request dispatcher. `acp.ts` is the JSON-RPC client for `devin acp`. `sessions.ts` keeps per-session event logs, status and pending permission requests. `git.ts`, `tasks.ts`, `terminal.ts` and `projects.ts` implement the Changes screen, command runs, PTY terminals and the project picker. `config.ts` reads flags and environment variables, and `static.ts` serves the built web UI.
- `app/src/lib/` holds the UI logic. `api.svelte.ts` owns the WebSocket connection and reactive app state, `timeline.ts` turns ACP session updates into chat items, and `ui.svelte.ts` has the hash router and preferences. Screens and shared components live in `app/src/lib/components/`.
- `app/src-tauri/` holds the Tauri v2 shell: `tauri.conf.json`, the Rust entry point, the iOS `Info.ios.plist` and the Android `MainActivity.kt` that CI copies into the generated project.
- `.github/workflows/ci.yml` runs type checks and builds. `.github/workflows/mobile.yml` builds the APK and IPA.

[gateway/README.md](gateway/README.md) describes the WebSocket protocol between the two packages. If you change a request or event, update that file in the same pull request.

## Conventions

- **Language**: TypeScript everywhere, in strict mode. The app imports its own modules through the `#lib/...` alias.
- **Svelte**: Svelte 5 with runes (`$state`, `$derived`, `$effect`, `$props`), which the Vite config enables for every component. Shared reactive state lives in `.svelte.ts` modules.
- **Formatting**: 2-space indentation. A few files that came from the SvelteKit template use tabs, so keep the style of the file you edit. The repository has no formatter configuration, so avoid reformatting code you did not change.
- **Comments**: explain why the code does something when it is not obvious, for example a platform quirk or a protocol detail.
- **Commits**: use [Conventional Commits](https://www.conventionalcommits.org/) with a scope, written in the imperative mood. Examples from the history:
  - `feat(app): show Devin plan, session token/context usage and a link to quota & credits`
  - `fix(gateway): page through the whole session list`
  - `fix(android): keep the composer above the keyboard`
  - `ci: build the APK and IPA on request or for a version tag only`

  Common scopes are `app`, `gateway`, `ios`, `android` and `native`. Common types are `feat`, `fix`, `docs`, `ci` and `build`.

## Before you open a pull request

Run the same checks as CI:

```bash
cd app && npm run check && npm run build
cd gateway && npm run typecheck && npm run build
```

Then try the change by hand. For UI changes, check a phone-sized and a tablet-sized window, the light, dark and dim themes, and the behaviour with Reduce Motion turned on. For gateway changes, check that reconnecting a client still replays what it missed.

## Pull request process

1. Fork the repository and create a branch from `master`.
2. Keep each pull request focused on one change. Separate refactors from behaviour changes.
3. Fill in the pull request template. Say what changed, why, and how you tested it, including the devices or browsers you used.
4. Add an entry under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
5. CI must pass. The maintainer reviews the change and may ask for edits. Pull requests are merged into `master` once approved.

## Reporting bugs

Open an issue with the bug report form at https://github.com/igomq/uniharn/issues/new/choose. Include:

- the app version and how you run it (Android APK, iOS IPA or browser), with the device and OS version
- the gateway version, the Devin CLI version (`devin --version`) and the Node.js version on the VM
- the steps that reproduce the problem, what you expected, and what happened
- relevant lines from the gateway log (`journalctl --user -u devin-mobile.service` if you use the systemd service)

Remove tokens and private paths from logs before you post them.

Do not report security vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead.

## Feature requests

Use the feature request form. Describe the problem you want to solve before the solution you have in mind. Devin Mobile is a remote control for Devin CLI, so features that need an editor, a separate model API or a server outside the VM are out of scope.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
