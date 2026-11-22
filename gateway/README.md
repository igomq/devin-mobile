# uniharn gateway

The VM-side service of [uniharn](../README.md). It provides a harness-agnostic ACP/adapter layer (`HarnessRegistry`, `DevinHarnessAdapter`, `WorkspaceStore`) and exposes connected coding harnesses to clients over a single authenticated WebSocket at `/ws`.

- **Sessions**: `session/new`, `session/load` (history replay), `session/list`, `session/close` and `session/delete`.
- **Turns**: `session/prompt` with streamed `session/update` notifications, `session/cancel`, and the `session/request_permission` round trip.
- **Controls**: `session/set_config_option` (model, reasoning, mode and others) and `session/set_mode`.
- **Extras**: Git status and diff, a test runner, and PTY terminals (a shell or the interactive `devin` TUI). All of them survive client disconnects.
- **Resume**: every session update gets a sequence number. Clients reconnect with `{epoch, sinceSeq}` and receive only what they missed.

## Usage

Requires Node.js 20 or later and a logged-in Devin CLI.

```bash
npm ci && npm run build
node dist/index.js --print-token   # binds 127.0.0.1 (+ Tailscale IPv4 if present), port 8787
```

The gateway also serves the built web UI from `../app/build` and answers `GET /healthz` with `{"ok": true, "version": "..."}`.

| Flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--port` | `UNIHARN_PORT` (fallback `DEVIN_MOBILE_PORT`) | `8787` | Port to listen on. |
| `--host` | `UNIHARN_HOST` (fallback `DEVIN_MOBILE_HOST`) | `127.0.0.1` and the Tailscale IPv4 address | Comma-separated list of addresses to bind. |
| `--roots` | `UNIHARN_ROOTS` (fallback `DEVIN_MOBILE_ROOTS`) | `~`, `~/repos`, `~/projects`, `~/code` | Comma-separated directories whose subdirectories the app offers as projects. |
| `--devin` | `DEVIN_BIN` | `~/.local/bin/devin`, `/usr/local/bin/devin`, `/opt/homebrew/bin/devin`, then `devin` on `PATH` | Devin CLI binary. |
| `--model` | `UNIHARN_MODEL` (fallback `DEVIN_MOBILE_MODEL`) | none | Passed to `devin acp` as `--model`. |
| `--static` | `UNIHARN_STATIC` (fallback `DEVIN_MOBILE_STATIC`) | `../app/build` | Directory of the web UI. `none` disables serving it. |
| `--data-dir` | `UNIHARN_DATA_DIR` (fallback `DEVIN_MOBILE_DATA_DIR`) | `~/.local/share/uniharn` | Where the token, harness configs, and workspace metadata live. |
| | `UNIHARN_TOKEN` (fallback `DEVIN_MOBILE_TOKEN`) | generated | Use this token instead of the token file. |
| `--print-token` | | | Print the master token at startup. |
| `--public-url` | `UNIHARN_PUBLIC_URL` | Tailscale MagicDNS name or IP | Address put in pairing links, e.g. an HTTPS `tailscale serve` URL. |
| `--strict-roots` | `UNIHARN_STRICT_ROOTS=1` | off | Refuse file, folder, Git and session paths outside `--roots`. |

The master token is generated on first start and stored in `~/.local/share/uniharn/token` with mode 0600 (automatically migrating from `~/.local/share/devin-mobile/token` if present). It still works for existing setups, but new devices should pair instead.

`scripts/install-gateway.sh [--systemd]` installs the `uniharn` command into `~/.local/bin`, runs `uniharn doctor`, optionally installs a systemd user service, and prints the pairing steps.

## Pairing and devices

```bash
uniharn pair                 # one-time code + terminal QR, valid 5 minutes (--ttl 30..900, --url, --json)
uniharn devices list         # paired devices
uniharn devices revoke <id>  # revoke one device; it is disconnected immediately
uniharn devices revoke-all
uniharn doctor | status      # diagnostics: Node, Tailscale IP/MagicDNS, bind warnings, harnesses, devices
uniharn service install | uninstall | status
```

A pairing code is 8 characters (`ABCD-EFGH`), works once and expires. The QR encodes `http(s)://<gateway>/#pair=<CODE>`: the code is only in the URL fragment, so it never reaches request logs, and the web app removes it from the address bar before any request. The QR never contains the master token or a device token. Clients exchange the code over `POST /api/pair` (`{"code", "deviceName?", "platform?"}`) or the WebSocket `pair` request and get a per-device token (`uhd_…`) plus `deviceId` and `gatewayId`.

Codes and device tokens are stored only as SHA-256 hashes in `<dataDir>/pairing.json` and `<dataDir>/devices.json` (mode 0600). Failed `hello` and pairing attempts are rate limited per client IP (HTTP 429 / error with retry time). Revoking a device closes its sockets with a `device_revoked` event and close code 4003 (reason `device revoked`), removes its Web Push subscriptions, and rejects the token on every later `hello`. Logs redact tokens, codes and bearer headers.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs `src/index.ts` with tsx. Pass flags after `--`. |
| `npm run build` | Compiles TypeScript into `dist/`. |
| `npm start` | Runs `dist/index.js`. |
| `npm run typecheck` | Runs `tsc --noEmit`. |
| `npm test` | Runs the `node:test` test suite. |

## WebSocket protocol

All messages are JSON text frames on `ws://<host>:<port>/ws`.

### Harnesses

Every harness is driven over ACP (JSON-RPC on stdio). Capabilities (session resume/close/delete, MCP, modes) come from the agent's `initialize` response.

| Harness | id | Command started | Status |
| --- | --- | --- | --- |
| Devin CLI | `devin` | `devin acp` | Verified |
| OpenAI Codex CLI | `codex` | `codex-acp` (`@agentclientprotocol/codex-acp`) | Sessions, prompts and model changes verified; needs `codex login` or `CODEX_API_KEY`/`OPENAI_API_KEY` |
| Claude Code | `claude` | `claude-agent-acp` (`@agentclientprotocol/claude-agent-acp`), falls back to `claude-code-acp` | Sessions, prompts, permissions and model switching verified |
| OpenCode | `opencode` | `opencode acp` | Prompts, worktree subagents and the `uniharn` MCP server verified |
| Kiro CLI | `kiro` | `kiro-cli acp` | Native ACP, not tested |
| Command Code | `command-code` | none documented | Disabled until `bin`/`args` point at an ACP command |
| Google Antigravity | `antigravity` | none documented | Disabled until `bin`/`args` point at an ACP command |
| Custom | any | `harnesses.registerCustom` | Any ACP agent |

`harnesses.configure` can override `bin`, `args` and `envAllowlist` for each. With a non-empty `envAllowlist`, the harness process only receives `PATH`, `HOME`, `USER`, `SHELL`, locale and XDG variables plus the listed keys. Missing binaries show `installed: false` and an `installHint`. An agent that returns `models` (`availableModels`) instead of a model config option gets a `model` select option, switched with `session/set_model`. An "Authentication required" error names the sign-in command and the agent's API key variables. See [docs/HARNESSES.md](../docs/HARNESSES.md) for the tested versions.

### Requests and responses

A client sends `{"id": <any>, "type": "<request>", ...params}`. The gateway answers with `{"type": "response", "id": <same id>, "ok": true, "result": {...}}` or `{"type": "response", "id": <same id>, "ok": false, "error": "<message>"}`. Requests without an `id` get no response.

The first request must be `hello` with a device token or the master token (or `pair` with a pairing code), sent within 10 seconds. Otherwise the gateway closes the socket with code 4001. A wrong token gets an error response followed by close code 4003. Any other request before `hello` fails with `Not authenticated`. The gateway pings each client every 20 seconds and drops clients that do not answer. Frames are limited to 32 MiB.

| Request | Parameters | Result |
| --- | --- | --- |
| `hello` | `token` | Gateway version, `gatewayId`, `protocolVersion` (2), `minAppVersion`, `deviceId`, `deviceName`, `authKind` (`device` or `master`), `security`, hostname, home directory, agent status, `harnesses`, `workspaces`, known sessions, terminals and task runs. |
| `pair` | `code`, `deviceName?`, `platform?` | `token`, `deviceId`, `device` and gateway info. Allowed before `hello`; the socket is authenticated as the new device. |
| `pairing.create` | `ttlSec?`, `url?` | `codeId`, `code`, `pairingUri`, `qrSvg`, `expiresAt`. |
| `pairing.list` / `pairing.revoke` | `codeId` (revoke) | Pending codes (no secrets) / `revoked`. |
| `devices.list` | | Devices with `current`, `lastSeenAt`, `revokedAt`. |
| `devices.rename` | `deviceId`, `name` | `device`. |
| `devices.revoke` | `deviceId` | `device`, `disconnected` (sockets closed). |
| `devices.rotate` | | New `token` for the calling device; the old one stops working at once. |
| `gateway.diagnostics` | | Same data as `uniharn doctor`. |
| `ping` | | `now` |
| `harnesses.list` | | Registered harness info list and custom ACP specs. |
| `harnesses.probe` | `harnessId?` | Probes one or all harnesses for installation, version, auth, and capabilities. |
| `harnesses.configure` | `harnessId`, `enabled?`, `bin?`, `args?`, `defaultModel?`, `envAllowlist?` | Persists harness configuration in `<dataDir>/harnesses.json`. |
| `harnesses.registerCustom` | `spec` (`id`, `name`, `command`, `args?`, `cwd?`, `envAllowlist?`, `enabled?`) | Saves a custom ACP agent definition and starts its adapter. Pass the fields under `spec`: a top-level `id` is the request id. |
| `harnesses.removeCustom` | `id` | Removes a custom ACP agent definition. |
| `workspaces.list` | | Persisted workspaces. |
| `workspaces.create` | `cwd`, `name?`, `harnessId?`, `repoRoot?`, `branch?` | Creates or returns the workspace for `cwd`. |
| `workspaces.get` | `workspaceId` | Returns a single workspace by ID. |
| `agent.status` | | Agent status and ACP capabilities. Starts `devin acp` if it is not running. |
| `agent.account` | `refresh?` | Login state and account fields from `devin auth status`, cached for 60 seconds. |
| `agent.authenticate` | `methodId` | Result of ACP `authenticate`. |
| `projects.list` | | Candidate project directories under the roots, plus the directories of known sessions. |
| `fs.listDirs` | `path?` | Subdirectories of `path` (default: home directory). |
| `sessions.list` | `cwd?` | Sessions known to Devin CLI, optionally for one directory. |
| `session.create` | `cwd` | New session summary and epoch. Subscribes the client to the session. |
| `session.open` | `sessionId`, `cwd?`, `epoch?`, `sinceSeq?` | Loads the session if needed and subscribes the client. Returns the summary, `epoch`, `events`, `full`, `truncated` and pending `permissions`. |
| `session.unsubscribe` | `sessionId` | Stops `event` messages for the session. |
| `session.prompt` | `sessionId`, `text`, `images?` (`{mimeType, data}`) | Starts a turn. Progress arrives as events. |
| `session.cancel` | `sessionId` | Cancels the running turn and any pending permission requests. |
| `session.permission` | `sessionId`, `requestId`, `optionId` | Answers a permission request. `null` cancels it. |
| `session.setConfig` | `sessionId`, `configId`, `value` | Updated session summary. |
| `session.setMode` | `sessionId`, `modeId` | Updated session summary. |
| `session.close` | `sessionId` | Cancels a running turn, calls ACP `session/close` when the agent supports it, and marks the session unloaded. |
| `session.delete` | `sessionId` | Deletes the session, or fails if this Devin CLI version cannot delete sessions. |
| `session.handoff` | `sessionId`, `harnessId`, `instruction?` | Starts a session on `harnessId` in the same folder, primed with the source transcript and `instruction`. Returns the `link`. |
| `orchestration.delegate` | `harnessId`, `task`, `sessionId?` or `cwd`, `worktree?`, `includeContext?`, `wait?` | Runs `task` as a subagent on `harnessId`. `worktree` runs it in a new git worktree. `includeContext` adds the parent transcript. `wait` returns after the turn ends. Returns the `link`. |
| `orchestration.list` | `sessionId?` | Handoff and subagent links, newest first, optionally only those touching one session. |
| `git.status` | `cwd` | Branch, upstream, ahead/behind and changed files with line counts, plus `repoRoot`, `detached`, `hasConflicts`, `operation` (`merge`/`rebase`/`cherry-pick`) and per-file `staged`/`unstaged`. |
| `git.diff` | `cwd`, `path?`, `scope?` | Diff for one file or the whole working tree; `scope` is `all` (default), `staged` or `unstaged`. |
| `git.log` | `cwd`, `limit?` | Recent commits (default 20). |
| `git.commitShow` | `cwd`, `hash` | One commit: body, changed files and diff. |
| `git.stage` / `git.unstage` | `cwd`, `paths?`, `all?` | Stage or unstage files; returns `git.status`. |
| `git.discard` | `cwd`, `paths`, `confirm: true` | Discard working-tree changes (untracked files are deleted). Refused without `confirm`. |
| `git.commit` | `cwd`, `message`, `all?`, `amend?` | Commit; returns `{ hash, subject, status }`. Also concludes a merge or cherry-pick. |
| `git.branches` | `cwd` | Local and remote branches with upstream, ahead/behind and last commit. |
| `git.checkout` | `cwd`, `branch` | Switch branch (a remote branch creates a tracking branch). |
| `git.createBranch` | `cwd`, `name`, `from?`, `checkout?` | Create a branch. |
| `git.deleteBranch` | `cwd`, `name`, `force?`, `confirmForce?` | Delete a merged branch; an unmerged one needs `force` and `confirmForce`. |
| `git.fetch` | `cwd`, `remote?`, `prune?` | Fetch. |
| `git.pull` | `cwd`, `remote?`, `branch?`, `rebase?` | Pull (merges unless `rebase` or `pull.rebase` is set); returns `{ ok, conflicts, output, status }`. |
| `git.push` | `cwd`, `remote?`, `branch?`, `setUpstream?`, `force?`, `confirmForce?` | Push. Force push uses `--force-with-lease` and needs `confirmForce`. |
| `git.conflicts` | `cwd` | The operation in progress and each conflicted file with ours/theirs hunks. |
| `git.resolveConflict` | `cwd`, `path`, `strategy`, `content?` | Resolve one file with `ours`, `theirs` or `manual` content and stage it. |
| `git.abortConflict` | `cwd`, `confirm: true` | Abort the merge, rebase or cherry-pick in progress. |
| `git.worktrees` / `git.worktreePrune` | `cwd` | List worktrees (dirty state, main, branch), or prune stale entries and list. |
| `git.worktreeAdd` | `cwd`, `taskSlug?` or `branch?`/`newBranch?`, `baseRef?`, `path?` | Create a worktree for a new task branch (`uniharn/<slug>`) or an existing branch. |
| `git.worktreeRemove` | `cwd`, `worktreePath`, `force?`, `confirmDirty?`, `deleteBranch?` | Remove a worktree; a dirty one needs `force` and `confirmDirty`. |
| `git.worktreeCompare` | `cwd`, `worktreePath`, `baseBranch?` | Ahead/behind, changed files and diff of a worktree branch against a base. |
| `git.worktreeMerge` | `cwd`, `worktreePath`, `targetBranch?`, `squash?`, `confirm?`, `removeAfter?` | Without `confirm`, a preview (commits, fast-forward, predicted conflicts); with it, merges into the target worktree. Refuses when either side has uncommitted changes. |
| `git.prStatus` | `cwd` | Whether `gh` is installed and signed in and the repo has a GitHub remote. |
| `git.prList` / `git.prView` / `git.prDiff` | `cwd`, `state?`/`limit?` or `number` | Pull requests through the host's `gh` login. |
| `git.prCreate` | `cwd`, `title`, `body?`, `base?`, `head?`, `draft?` | Create a pull request with `gh pr create`. |
| `git.sessionPrGet` / `git.sessionPrLink` / `git.sessionPrUnlink` | `sessionId`, `link?` | The pull request linked to a session, persisted in the data dir. |
| `tasks.detect` | `cwd` | The detected test command, or `null`. |
| `tasks.run` | `cwd`, `command?` | Starts a command (the detected test command by default). Output arrives as events. |
| `tasks.get` | `taskId` | The run, including its output. |
| `tasks.list` | `cwd?` | Runs, without output. |
| `tasks.stop` | `taskId` | Stops a run. |
| `term.open` | `cwd?`, `cols?`, `rows?`, `kind?` (`shell` or `devin`), `args?` | Starts a PTY and attaches the client. |
| `term.attach` | `termId` | Attaches to an existing PTY and returns its scrollback. |
| `term.detach` | `termId` | Stops `term_data` messages for the PTY. |
| `term.input` | `termId`, `data` | Writes to the PTY. |
| `term.resize` | `termId`, `cols`, `rows` | Resizes the PTY. |
| `term.close` | `termId` | Kills the PTY. |
| `term.list` | | Open and exited PTYs. |
| `notifications.list` | `sinceSeq?`, `limit?`, `unreadOnly?` | Stored notifications (newest 200), `lastSeq`, `unreadCount`. Pass the last seen `seq` after a reconnect to get only missed ones. |
| `notifications.read` | `ids?` | Marks notifications read (all when `ids` is omitted). |
| `notifications.clear` | | Deletes the stored notifications. |
| `notifications.prefs.get` | | Notification preferences. |
| `notifications.prefs.set` | `prefs` | Merges and saves preferences (`enabled`, `inApp`, `webPush`, `hideSensitiveDetails`, `dedupWindowMs`, `attentionTimeoutMs`, `events`). |
| `notifications.capabilities` | | What each platform (in-app, Web Push, Android FCM, iOS APNs) supports and why. |
| `notifications.test` | | Fires a test notification, including Web Push, and returns the delivery result. |
| `notifications.push.publicKey` | | The gateway's VAPID public key. |
| `notifications.push.subscribe` | `subscription`, `label?` | Saves a browser `PushSubscription`. |
| `notifications.push.unsubscribe` | `endpoint` | Removes a push subscription. |
| `notifications.push.list` | `endpoint?` | Subscriptions without their keys. |

A `cwd` that starts with `~` is resolved against the home directory of the user running the gateway.

### Pushed events

The gateway pushes these messages without a request:

| Type | Sent to | Fields |
| --- | --- | --- |
| `event` | Clients subscribed to the session | `sessionId`, `epoch`, `seq`, `at`, `update` |
| `session_state` | All clients | `session` (summary with status, title, config options, modes, usage and pending permission count) |
| `session_reset` | Clients subscribed to the session | `sessionId`, `epoch` |
| `session_deleted` | All clients | `sessionId` |
| `agent_status` | All clients | `agent` |
| `permission_request` | All clients | `sessionId`, `title`, `requestId`, `toolCall`, `options` |
| `permission_resolved` | All clients | `sessionId`, `requestId`, `optionId` (`null` when cancelled) |
| `task_output` | All clients | `taskId`, `cwd`, `chunk` |
| `task_done` | All clients | `task` |
| `term_data` | Clients attached to the terminal | `termId`, `data` |
| `term_exit` | All clients | `term` |
| `orchestration_link` | All clients | `link` (created, then updated when the child turn ends) |
| `notification` | All clients | `notification` (`id`, `seq`, `type`, `severity`, `title`, `body`, `safeBody`, `sessionId`, `route`, `at`, `read`) |
| `notification_read` | All clients | `ids`, `unreadCount` |
| `notifications_cleared` | All clients | |

The `update` of an `event` is an ACP `session/update` payload, or one of the records the gateway adds to the log: `_turn_end` (with `stopReason`), `_turn_error` (with `message`), `_permission_request` and `_permission_resolved`. The user's own prompt is logged as a `user_message_chunk` marked `_local`. Config option, mode, title and command changes and usage updates also update the session summary, which arrives as `session_state`.

### Handoff and subagents

A link records one handoff or subagent run: `id`, `kind` (`handoff` or `delegate`), `parentSessionId`, `childSessionId`, `harnessId`, `task`, `cwd`, `worktree`, `branch`, `status` (`running`, `done` or `error`), `output` (the child's last reply), `stopReason`, `error`, `createdAt` and `updatedAt`. Links are stored in `<dataDir>/orchestration.json`.

A handoff sends the target harness a prompt with the source session's transcript (user and agent messages and tool call titles, last 12,000 characters) and the instruction.

With `worktree`, the gateway runs `git worktree add -b uniharn/sub-<id> <repo>/.uniharn/worktrees/<id>` and adds `/.uniharn/` to the repo's `info/exclude`. The worktree and branch are kept for review; remove them with `git worktree remove`.

When a subagent finishes, the harness registry emits `subagent_completed` with `taskId`, `harnessId`, `title`, `parentSessionId`, `ok` and `summary`.

Harnesses can delegate too. The gateway offers every ACP session an MCP server named `uniharn` (`node dist/mcp.js`, also installed as `uniharn-mcp`) with the tools `list_harnesses`, `delegate_task` and `list_delegations`. It connects back to the gateway with the pairing token, read from `<dataDir>/mcp-token` (mode 0600; the token itself is never put in the ACP request). Set `UNIHARN_SUBAGENT_MCP=0` to turn this off.

`hello` also returns `notifications` (`unreadCount`, `lastSeq`). Notification types, Web Push setup and platform limits are described in [docs/NOTIFICATIONS.md](../docs/NOTIFICATIONS.md).

### Resuming a session

Each session keeps its last 20,000 events, each with an increasing `seq`. Whenever the gateway loads a session from Devin CLI, for example the first time a client opens it after `devin acp` restarts, it clears the log, starts a new `epoch` and sends `session_reset`. Devin CLI then replays the history as new events.

To resume, a client calls `session.open` with the `epoch` and the last `seq` it has seen as `sinceSeq`. If the epoch matches and the events after `sinceSeq` are still retained, the result contains only the newer events and `full` is `false`. Otherwise the result is a full snapshot with `full: true`, and `truncated: true` if older events were dropped.

Task output is kept up to 512 KiB per run, and terminal scrollback up to 256 KiB per PTY.

## License

MIT. See [LICENSE](../LICENSE).
