# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Rebranded the platform to **uniharn** (`me.gomq.uniharn`, `uniharn-gateway`, `uniharn-app`, `UNIHARN_*` env vars) with automatic migration from legacy `DEVIN_MOBILE_*` env vars, `~/.local/share/devin-mobile/token`, and `devin-mobile.*` browser storage keys.
- Harness-agnostic ACP client (`AcpConnection`), `HarnessAdapter` / `HarnessRegistry` foundation, `DevinHarnessAdapter`, and `WorkspaceStore` persistence in the gateway.
- Additive WebSocket RPCs (`harnesses.list`, `harnesses.probe`, `harnesses.configure`, `harnesses.registerCustom`, `harnesses.removeCustom`, `workspaces.list`, `workspaces.create`, `workspaces.get`).
- Generic ACP harness adapter with built-in Codex (`codex-acp`), Claude Code (`claude-code-acp`), OpenCode (`opencode acp`) and Kiro (`kiro-cli acp`) harnesses; Command Code and Antigravity are listed but disabled until pointed at an ACP command. Custom ACP definitions now start real adapters. Per-harness env allowlists.
- Harness picker for new sessions and a harness badge on non-Devin session rows.
- Cross-harness handoff (`session.handoff`) and subagent delegation (`orchestration.delegate`, `orchestration.list`) with optional git worktree isolation, persisted links and `orchestration_link` events. Session controls in the app to hand off a session or run a subagent and open its result.
- `uniharn` MCP server (`list_harnesses`, `delegate_task`, `list_delegations`) offered to every ACP session so one harness can delegate to another.
- Notifications: in-app banners and a notification center, plus Web Push for browsers and Home Screen PWAs, for approval requests, finished and failed runs, subagent results, Git conflicts, gateway disconnects and long waits. Per-event settings, duplicate suppression, catch-up after reconnects, and lock-screen-safe text by default. Native FCM/APNs push is not included; see `docs/NOTIFICATIONS.md`.
- Automated `node:test` test suite for gateway config migration, ACP JSON-RPC, harness registry, workspace persistence, and Devin adapter regression, wired into CI.

## [0.2.0] - 2026-11-22

### Added

- Layouts for iPhone, Android phones and iPad or Android tablets. On wide screens the session list stays in a collapsible sidebar next to the open session.
- A translucent Liquid Glass-style interface with light, dark and dim themes and accent colors. It respects the system Reduce Transparency and Reduce Motion settings.
- Session search. Sessions waiting for approval are listed first.
- The composer keeps an unsent draft for each session.
- Copy a reply.
- Live elapsed time while Devin works.
- A +/− diff summary in the chat header that opens the Changes screen.
- Paste or drop images into the composer.
- Hardware keyboard shortcuts on tablets: Cmd/Ctrl+N for a new session, Cmd/Ctrl+K to search sessions, Cmd/Ctrl+, for settings, Cmd/Ctrl+\ to toggle the sidebar, and Esc to stop a running turn.
- The MIT license, a contributing guide, a code of conduct, a security policy, and issue and pull request templates.
- GitHub Releases for version tags, with the Android APK and the iOS IPA attached. Optional repository secrets give the APK a stable signature so updates install over the previous version.

### Changed

- Redesigned interface.
- The app identifier is now `me.gomq.devinmobile`. The app installs as a new app, so remove the old one.

### Fixed

- Session titles no longer take the accent color.

## [0.1.0] - 2026-11-21

First release.

### Added

- A Node gateway that runs one long-lived `devin acp` process and exposes it over an authenticated WebSocket, with Git status and diff, a test runner and PTY terminals that survive client disconnects.
- Sequence-numbered session events, so clients that reconnect receive only what they missed.
- A SvelteKit mobile UI with sessions and projects, streamed chat with Markdown and code, collapsible thinking and tool calls, image attachments, approvals that show the command or diff, mode, model, thinking level and speed controls, a Changes screen with per-file diffs and test runs, and a terminal for a shell or the `devin` TUI.
- A Fusion pair picker and a model chip in the composer, dark and dim themes, accent colors and subtle motion.
- The Devin plan, session token and context usage, and a link to the quota and credits page.
- Pretendard for UI text and JetBrains Mono for code and the terminal.
- A Tauri v2 shell, with CI builds of an arm64 Android APK and an unsigned iOS IPA on request or for version tags.
- Notifications while the app is in the background, where the webview supports them.

### Fixed

- The Android composer stays above the keyboard, and status bar icons are readable.
- iOS no longer zooms into text inputs, and long permission options scroll.
- The gateway pages through the whole session list, loads a session once when several clients open it at the same time, and resolves pending approvals on clients when the agent exits.
- Deleting a session on a Devin CLI version that cannot delete sessions reports an error instead of claiming success.
- A Content-Security-Policy for the native webview that still allows inline styles.

[Unreleased]: https://github.com/igomq/devin-mobile/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/igomq/devin-mobile/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/igomq/devin-mobile/releases/tag/v0.1.0
