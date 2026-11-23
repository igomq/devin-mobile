#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 || (${1:-} != "" && ${1:-} != "--systemd") ]]; then
  echo "Usage: $0 [--systemd]" >&2
  exit 2
fi

if [[ $EUID -eq 0 ]]; then
  echo "Warning: install and run the gateway as a non-root user." >&2
fi

if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 20 ? 1 : 0)'; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
gateway_dir="$repo_dir/gateway"
bin_dir="$HOME/.local/bin"
launcher="$bin_dir/uniharn"
if [[ -e "$launcher" && ! -L "$launcher" ]]; then
  echo "An existing executable occupies $launcher. Move it before installing." >&2
  exit 1
fi

(cd "$repo_dir/app" && npm ci && npm run build)
cd "$gateway_dir"
npm ci --include=dev
npm run build
chmod +x dist/index.js
mkdir -p "$bin_dir"
ln -sfn "$gateway_dir/dist/index.js" "$launcher"

# Codex and Claude Code speak ACP through separate adapter packages.
install_adapter() {
  local cli=$1 adapter=$2 package=$3
  if command -v "$cli" >/dev/null && ! command -v "$adapter" >/dev/null; then
    echo "Installing $package for $cli..."
    npm i -g "$package" || echo "Could not install $package; run: npm i -g $package" >&2
  fi
}
install_adapter codex codex-acp @agentclientprotocol/codex-acp
install_adapter claude claude-agent-acp @agentclientprotocol/claude-agent-acp

"$launcher" doctor
if [[ ${1:-} == "--systemd" ]]; then
  "$launcher" service install
fi

echo "Gateway installed at $launcher."
if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
  echo "Add $bin_dir to PATH to use the uniharn command."
fi
if [[ ${1:-} == "--systemd" ]]; then
  echo "Pair a device with: uniharn pair (or run uniharn and press Enter for the QR)"
else
  echo "Start the gateway with: uniharn (press Enter to show the pairing QR)"
fi
