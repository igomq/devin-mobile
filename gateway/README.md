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
| `--print-token` | | | Print the pairing token at startup. |

The pairing token is generated on first start and stored in `~/.local/share/uniharn/token` with mode 0600 (automatically migrating from `~/.local/share/devin-mobile/token` if present).

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

### Requests and responses

A client sends `{"id": <any>, "type": "<request>", ...params}`. The gateway answers with `{"type": "response", "id": <same id>, "ok": true, "result": {...}}` or `{"type": "response", "id": <same id>, "ok": false, "error": "<message>"}`. Requests without an `id` get no response.

The first request must be `hello` with the pairing token, sent within 10 seconds. Otherwise the gateway closes the socket with code 4001. A wrong token gets an error response followed by close code 4003. Any other request before `hello` fails with `Not authenticated`. The gateway pings each client every 20 seconds and drops clients that do not answer. Frames are limited to 32 MiB.

| Request | Parameters | Result |
| --- | --- | --- |
| `hello` | `token` | Gateway version, hostname, home directory, agent status, `harnesses`, `workspaces`, known sessions, terminals and task runs. |
| `ping` | | `now` |
| `harnesses.list` | | Registered harness info list and custom ACP specs. |
| `harnesses.probe` | `harnessId?` | Probes one or all harnesses for installation, version, auth, and capabilities. |
| `harnesses.configure` | `harnessId`, `enabled?`, `bin?`, `args?`, `defaultModel?`, `envAllowlist?` | Persists harness configuration in `<dataDir>/harnesses.json`. |
| `harnesses.registerCustom` | `id`, `name`, `command`, `args?`, `cwd?`, `envAllowlist?` | Saves a custom ACP agent definition. |
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
| `git.status` | `cwd` | Branch and changed files with line counts. |
| `git.diff` | `cwd`, `path?` | Diff for one file or the whole working tree. |
| `git.log` | `cwd`, `limit?` | Recent commits (default 20). |
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
| `notification` | All clients | `notification` (`id`, `seq`, `type`, `severity`, `title`, `body`, `safeBody`, `sessionId`, `route`, `at`, `read`) |
| `notification_read` | All clients | `ids`, `unreadCount` |
| `notifications_cleared` | All clients | |

The `update` of an `event` is an ACP `session/update` payload, or one of the records the gateway adds to the log: `_turn_end` (with `stopReason`), `_turn_error` (with `message`), `_permission_request` and `_permission_resolved`. The user's own prompt is logged as a `user_message_chunk` marked `_local`. Config option, mode, title and command changes and usage updates also update the session summary, which arrives as `session_state`.

`hello` also returns `notifications` (`unreadCount`, `lastSeq`). Notification types, Web Push setup and platform limits are described in [docs/NOTIFICATIONS.md](../docs/NOTIFICATIONS.md).

### Resuming a session

Each session keeps its last 20,000 events, each with an increasing `seq`. Whenever the gateway loads a session from Devin CLI, for example the first time a client opens it after `devin acp` restarts, it clears the log, starts a new `epoch` and sends `session_reset`. Devin CLI then replays the history as new events.

To resume, a client calls `session.open` with the `epoch` and the last `seq` it has seen as `sinceSeq`. If the epoch matches and the events after `sinceSeq` are still retained, the result contains only the newer events and `full` is `false`. Otherwise the result is a full snapshot with `full: true`, and `truncated: true` if older events were dropped.

Task output is kept up to 512 KiB per run, and terminal scrollback up to 256 KiB per PTY.

## License

MIT. See [LICENSE](../LICENSE).
