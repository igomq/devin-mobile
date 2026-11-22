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
- Command Code and Antigravity can be used by pointing `bin`/`args` at an ACP-compatible command with `harnesses.configure`, or by registering a custom ACP harness.
