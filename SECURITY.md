# Security policy

## Supported versions

Only the latest release receives security fixes. Update the app and the gateway to the latest release before reporting an issue.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting. Open https://github.com/igomq/devin-mobile/security/advisories/new, or go to the Security tab of the repository and choose "Report a vulnerability".

Do not open a public issue, pull request or discussion for a vulnerability.

Include the affected version, the component (app or gateway), the steps to reproduce, and the impact you expect. The maintainer will acknowledge the report, keep you updated in the advisory, and credit you when the fix is published unless you ask not to be credited.

## Threat model

Devin Mobile is designed for one person who controls one Linux VM from their own devices over a private Tailscale tailnet.

- **Pairing token**: the gateway authenticates every WebSocket connection with a single random token (32 bytes, base64url-encoded). A client must send the token in its first message within 10 seconds, and the gateway compares it in constant time. Anyone with the token can use Devin CLI, run commands and open a shell on the VM as the user that runs the gateway, so treat it like an SSH private key.
- **Token storage**: the gateway stores the token in `~/.local/share/devin-mobile/token` with mode 0600, in a data directory created with mode 0700. You can supply the token with `DEVIN_MOBILE_TOKEN` instead. On the phone the token is kept in the app's local storage.
- **Network exposure**: by default the gateway listens only on `127.0.0.1` and the VM's Tailscale IPv4 address. It binds elsewhere only when you pass `--host` or set `DEVIN_MOBILE_HOST`.
- **No TLS**: the gateway speaks plain HTTP and WebSocket. Confidentiality and integrity depend on the tailnet, which encrypts traffic with WireGuard. Exposing the gateway on a public interface sends the token and all session content in clear text.
- **Devin credentials**: Devin CLI's login stays on the VM. The app never receives Devin credentials. It only sees what the gateway forwards from `devin acp` and `devin auth status`.
- **Single tenant**: there is one token and one `devin acp` process per gateway. There are no per-user accounts or permissions.

Issues that require the attacker to already have the pairing token or a shell on the VM are outside this model.
