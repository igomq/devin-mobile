# Security policy

## Supported versions

Only the latest release receives security fixes. Update the app and the gateway to the latest release before reporting an issue.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting. Open https://github.com/igomq/uniharn/security/advisories/new, or go to the Security tab of the repository and choose "Report a vulnerability".

Do not open a public issue, pull request or discussion for a vulnerability.

Include the affected version, the component (app or gateway), the steps to reproduce, and the impact you expect. The maintainer will acknowledge the report, keep you updated in the advisory, and credit you when the fix is published unless you ask not to be credited.

## Threat model

uniharn is designed for one person who controls one Linux VM from their own devices over a private Tailscale tailnet. Everything below runs as the user that starts the gateway.

### Authentication

- **Master token**: 32 random bytes (base64url) in `~/.local/share/uniharn/token` (mode 0600, data directory 0700), or `UNIHARN_TOKEN`. It is migrated once from `~/.local/share/devin-mobile/token`, and `DEVIN_MOBILE_*` variables are still read. Anyone with it can run every harness, run commands and open a shell on the VM, so treat it like an SSH private key.
- **Device tokens and pairing**: `uniharn pair` issues a one-time code (default 5 minutes) that a device exchanges for its own `uhd_…` token. Codes and device tokens are stored only as SHA-256 hashes. A device can be renamed, rotated or revoked; revoking closes its sockets and removes its Web Push subscriptions. The pairing QR and link carry the code in the URL fragment only, never a token.
- **Checks**: the first WebSocket message must authenticate within 10 seconds, tokens are compared in constant time, and failed `hello` and pairing attempts are rate limited per IP (10 per minute). Logs redact tokens.

### Network

- By default the gateway listens only on `127.0.0.1` and the VM's Tailscale IPv4 address, and warns when it binds a public address or runs as root.
- It speaks plain HTTP and WebSocket. Confidentiality depends on the tailnet's WireGuard encryption, or on `tailscale serve` for HTTPS (which Web Push needs).
- Static responses send `X-Frame-Options: DENY` and a camera-only `Permissions-Policy`.

### Harnesses and agents

- **Credentials stay on the VM**: each harness keeps its own login (`devin auth`, `codex login`, `claude /login`, API keys in the environment). The app never receives them.
- **Environment**: the gateway removes `UNIHARN_TOKEN` from its own environment at startup, so no child process inherits the master token. A harness inherits the rest of the gateway's environment unless its `envAllowlist` is set; then it gets only `PATH`, `HOME`, locale and XDG variables plus the listed names. Set an allowlist when the gateway's environment holds keys a harness should not see.
- **Custom ACP agents**: adding one runs the configured command as the gateway user. Only an authenticated client can add or change one, and that client can already open a shell.
- **`uniharn` MCP server**: agents get delegation tools through an MCP server that connects back to the gateway. Its token is read from `<dataDir>/mcp-token` (mode 0600); only the file path is passed in ACP requests, so the token never appears in agent prompts or logs. An agent with these tools can start sessions on other harnesses with the same rights as the user.
- **Worktrees**: delegated subagents can run in a separate Git worktree under `.uniharn/worktrees/`, which keeps their edits off your branch. It is isolation for changes, not a sandbox: the agent can still read and write anything the gateway user can.
- **Paths**: directories are limited to the configured roots only with `--strict-roots` (or `UNIHARN_STRICT_ROOTS=1`); otherwise any directory the user can read is allowed.

### Notifications

With "Hide sensitive details" on, Web Push payloads carry only a generic title and short text, not commands or agent output. Payloads are encrypted for each browser subscription, and the VAPID keys stay in the data directory (0600). Native FCM/APNs push is not implemented; see `docs/NOTIFICATIONS.md`.

### Out of scope

uniharn is single tenant: there are no per-user permissions, and every paired device has the same rights. Issues that require the attacker to already have a token or a shell on the VM are outside this model, as is anything a harness or model provider does with the code and prompts you send to it.
