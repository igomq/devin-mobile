# Devin Mobile app

The user interface of [Devin Mobile](../README.md): a SvelteKit single-page app that talks to the gateway over one WebSocket, packaged for iOS, iPadOS and Android with Tauri v2. The gateway also serves the same build to browsers.

## Stack

- [Svelte 5](https://svelte.dev) with runes, and [SvelteKit](https://svelte.dev/docs/kit) with `adapter-static`. SSR and prerendering are off, and the build falls back to `index.html`, so the output in `build/` is a static single-page app.
- [Vite](https://vite.dev) for the dev server and build.
- [Tauri v2](https://v2.tauri.app) for the native shell. The app identifier is `me.gomq.devinmobile`.
- [xterm.js](https://xtermjs.org) for the terminal, [marked](https://marked.js.org) and [DOMPurify](https://github.com/cure53/DOMPurify) for Markdown, and [highlight.js](https://highlightjs.org) for code.
- [Pretendard](https://github.com/orioncactus/pretendard) for UI text and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) for code and the terminal, bundled with the app.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the Vite dev server on http://localhost:5173. |
| `npm run build` | Builds the static app into `build/`. The gateway serves this directory by default. |
| `npm run preview` | Serves the production build locally. |
| `npm run check` | Runs `svelte-kit sync` and `svelte-check` for type checking. |
| `npm run tauri -- <args>` | Runs the Tauri CLI. The Xcode and Gradle build phases call this script. |

## Source layout

`src/routes/+page.svelte` is the only page. It shows the connect screen until the app is paired, then picks a screen from the hash route.

`src/lib/` holds the logic shared by the screens:

| File | Purpose |
| --- | --- |
| `api.svelte.ts` | The WebSocket connection to the gateway: requests, pushed events, automatic reconnect and per-session resume from the last seen sequence number. Also holds the reactive app and session state. |
| `timeline.ts` | Folds the gateway's ACP session updates into the list of items the chat renders (user, assistant, thought, tool, plan and notice). |
| `ui.svelte.ts` | The hash router (`#/s/<id>`, `#/settings`, `#/terminal`) and UI preferences such as theme and accent color. |
| `format.ts` | Markdown rendering, syntax highlighting, diff parsing and path helpers. |
| `models.ts` | Splits Devin CLI's model option into single models and Fusion (main plus sidekick) pairs. |
| `usage.ts` | Token count formatting and the link to the Devin usage page. |
| `types.ts` | Types shared with the gateway protocol. |

`src/lib/components/` holds the screens and the components they share:

| Component | Purpose |
| --- | --- |
| `Connect.svelte` | Pairing screen for the gateway address and token. |
| `Home.svelte` | Session list, search and new session. |
| `Chat.svelte` | The conversation, composer and turn controls for one session. |
| `Changes.svelte` | Changed files, per-file diffs and command runs for a session's project. |
| `Terminal.svelte` | xterm.js view of a PTY on the VM (shell or `devin` TUI). |
| `Settings.svelte` | Connection, account and usage, theme, accent color and notifications. |
| `Permission.svelte` | Approval card for a permission request. |
| `ToolCall.svelte` | A tool call in the chat, with its command, output or diff. |
| `SessionControls.svelte` | Mode, model, thinking level and speed for a session. |
| `ModelPicker.svelte` | Picker for single models and Fusion pairs. |
| `DirPicker.svelte` | Project and directory picker for new sessions. |
| `DiffRows.svelte` | Rendered diff lines with highlighting. |
| `Sheet.svelte` | Bottom sheet used by pickers and menus. |
| `BackButton.svelte`, `Icon.svelte` | Small shared controls and the icon set. |

Modules are imported through the `#lib` alias, for example `import { conn } from '#lib/api.svelte.ts'`. Runes are enabled for every component in `vite.config.ts`, and shared reactive state lives in `.svelte.ts` modules.

## Mobile builds

`src-tauri/` holds the Tauri project. `tauri.conf.json` points the native webview at `build/` for release builds and at the dev server for `tauri dev`. It also sets a Content-Security-Policy that allows `ws:` and `wss:` connections to any host, because the gateway address is chosen at runtime.

The platform projects in `src-tauri/gen/` are generated and not committed. Create them with `npx tauri android init` or `npx tauri ios init`, then run `npx tauri android dev` or `npx tauri ios dev`. You need the Android SDK and NDK, or Xcode on macOS, and a Rust toolchain.

Gateways are reached over plain `ws://` inside the tailnet, so both platforms allow cleartext traffic:

- **iOS**: `src-tauri/Info.ios.plist` sets `NSAllowsArbitraryLoads` and the local network usage description. Tauri merges it into the generated Info.plist.
- **Android**: the [Mobile builds](../.github/workflows/mobile.yml) workflow sets `usesCleartextTraffic` to `true` in the generated `build.gradle.kts`, and replaces the generated `MainActivity` with `src-tauri/android/MainActivity.kt`. That activity keeps the webview clear of the system bars and the on-screen keyboard, and colors the system bars to match the theme. Make the same two changes after `tauri android init` when you build locally.

CI builds an arm64 release APK, signed with the key from the repository secrets or a throwaway key, and an unsigned arm64 IPA. See [Releasing](../README.md#releasing) in the root README.
