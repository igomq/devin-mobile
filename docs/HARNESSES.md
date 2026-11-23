# Harness compatibility

uniharn drives every harness over ACP (JSON-RPC on stdio). This page lists what was tested against real agents and what is not.

Tested on Linux x64 with gateway 0.3.0 (unreleased), November 2026.

| Harness | Version tested | initialize | session/new | Prompt | Model switch | `uniharn` MCP | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Devin CLI | 3000.14 | Yes | Yes | Yes | config option | Offered; tested with a mock agent | Reference harness |
| OpenCode | 1.19.6 (`opencode acp`) | Yes | Yes | Yes | config option | Yes, called `list_harnesses` | Ran as a worktree subagent |
| Claude Code | 2.1.330 with `claude-agent-acp` 0.23.1 | Yes | Yes | Yes, with permission approval and cancel | `session/set_model` | Not run | Uses the signed-in Claude account |
| OpenAI Codex | 0.171.0 with `@agentclientprotocol/codex-acp` | Yes | Yes | Yes | Yes | Not run | Signed in with ChatGPT (`codex login`); without sign-in `session/new` fails with `Authentication required` |
| Kiro CLI | not installed | - | - | - | - | - | `kiro-cli acp`, untested |
| Command Code | - | - | - | - | - | - | No documented ACP entrypoint; disabled |
| Google Antigravity | - | - | - | - | - | - | IDE without an ACP CLI; disabled |

Capabilities reported by the agents' `initialize`:

| Harness | loadSession | list | resume | close | fork | MCP transports |
| --- | --- | --- | --- | --- | --- | --- |
| OpenCode | Yes | Yes | Yes | Yes | Yes | stdio, http, sse |
| Claude Code | Yes | Yes | Yes | Yes | Yes | stdio, http, sse |
| Codex | Yes | Yes | Yes | Yes | No | stdio, http |

## Limits

- uniharn does not use `session/resume` or `session/fork` yet; resuming uses `session/load`.
- Reasoning levels and token usage are only shown for harnesses that send them as config options or Devin's turn stats.
- Codex and Claude Code sign-in happens in their own CLIs (`codex login`, `claude /login`); the gateway's `agent.authenticate` only covers Devin.

## Login state

The gateway checks each login with the harness's own CLI, separately from whether its ACP process runs:

| Harness | Command | Notes |
|---|---|---|
| Devin | `devin auth status` | Account name, email, plan and tier are shown. Plan quota comes from the user-status call the Devin CLI makes with its stored login. |
| Codex | `codex login status` | Needs the `codex` CLI next to `codex-acp`. Only the method (ChatGPT or API key) is kept, never the key. |
| Claude Code | `claude auth status` | Expired when `loginExpiresAt` has passed. An API key from the environment is `unknown`, because Claude reports any key as logged in without checking it. |
| OpenCode | `opencode auth list` | Stored credentials count as logged in; keys found only in the environment are `unknown`. |
| Kiro | `kiro-cli whoami --format json` | Logged-out output verified with kiro-cli 3.5.0; the logged-in format has not been tested. |
| Custom ACP | none | `unknown` until the agent rejects a request with an authentication error. |

When the status command is missing or prints something unexpected the state is `unknown`, never `authenticated`.
- Command Code and Antigravity can be used by pointing `bin`/`args` at an ACP-compatible command with `harnesses.configure`, or by registering a custom ACP harness.
