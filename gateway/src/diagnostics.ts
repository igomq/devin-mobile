import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, isIP } from 'node:net';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { WebSocket } from 'ws';
import { type AuthStore, MIN_APP_VERSION, PROTOCOL_VERSION, validatePairingUrl } from './auth.js';
import type { Config } from './config.js';
import type { HarnessRegistry } from './harnesses/registry.js';
import { isPublicBindHost, isRunningAsRoot, redactSecrets } from './security.js';

export const VERSION = '0.3.0';

export function gatewaySecurity(config: Config) {
  return {
    isRoot: isRunningAsRoot(),
    strictRoots: config.strictRoots,
    publicBindWarning: config.hosts.some(isPublicBindHost),
    tailscaleIp: config.tailscaleIp,
    magicDns: config.magicDns,
  };
}

export function gatewayUrl(host: string, port: number): string {
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

function probeHost(host: string): string {
  if (isPublicBindHost(host)) return host === '::' ? '::1' : '127.0.0.1';
  return host;
}

export function suggestedUrls(config: Config): string[] {
  const hosts = config.hosts.map(probeHost);
  if (config.tailscaleIp && (config.hosts.includes(config.tailscaleIp) || config.hosts.some(isPublicBindHost))) {
    hosts.unshift(...[config.magicDns, config.tailscaleIp].filter((host): host is string => !!host));
  }
  const candidates = [config.publicUrl, ...hosts.map((host) => gatewayUrl(host, config.port))];
  return [...new Set(candidates.filter((url): url is string => {
    if (!url) return false;
    try {
      validatePairingUrl(url, config.token);
      return true;
    } catch {
      return false;
    }
  }))];
}

export function collectDiagnostics(config: Config, registry: HarnessRegistry, authStore: AuthStore, activeClientsCount: number) {
  return {
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    minAppVersion: MIN_APP_VERSION,
    nodeVersion: process.version,
    hostname: hostname(),
    ...gatewaySecurity(config),
    hosts: config.hosts,
    port: config.port,
    suggestedUrls: suggestedUrls(config),
    roots: config.roots,
    harnesses: registry.list().map(({ id, name, version, installed, enabled, authStatus, status, error }) => ({
      id, name, version, installed, enabled, authStatus, status,
      error: error ? redactSecrets(error, [config.token]) : null,
    })),
    pairedDeviceCount: authStore.listDevices().filter((device) => device.revokedAt === null).length,
    activeDeviceCount: activeClientsCount,
    updateHint: 'Run scripts/install-gateway.sh from an updated checkout.',
  };
}

export function checkGatewayPorts(config: Config) {
  return Promise.all(config.hosts.map((host) => new Promise<{ host: string; reachable: boolean }>((resolve) => {
    const socket = createConnection({ host: probeHost(host), port: config.port, timeout: 1500 });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve({ host, reachable });
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  })));
}

/** URL of a gateway with this ID already listening on one of the configured local addresses, if any. */
export async function findRunningGateway(config: Config, gatewayId: string): Promise<string | null> {
  for (const host of config.hosts.map(probeHost)) {
    const url = gatewayUrl(host, config.port);
    try {
      const response = await fetch(`${url}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.json()).gatewayId === gatewayId) return url;
    } catch {
      // Nothing listening there.
    }
  }
  return null;
}

interface GatewayAuthCheck {
  gatewayAuth: 'authenticated' | 'rejected' | 'unavailable';
  activeDeviceCount: number;
}

export async function checkGatewayAuth(config: Config, gatewayId: string): Promise<GatewayAuthCheck> {
  const unavailable: GatewayAuthCheck = { gatewayAuth: 'unavailable', activeDeviceCount: 0 };
  const local = new Set(Object.values(networkInterfaces()).flatMap((entries) => entries?.map((entry) => entry.address) ?? []));
  for (const host of config.hosts.map(probeHost)) {
    if (host !== 'localhost' && !(isIP(host) && local.has(host))) continue;
    const url = gatewayUrl(host, config.port);
    try {
      const response = await fetch(`${url}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
      if (!response.ok || (await response.json()).gatewayId !== gatewayId) continue;
      return await new Promise<GatewayAuthCheck>((resolve) => {
        const ws = new WebSocket(url.replace(/^http:/, 'ws:') + '/ws', { handshakeTimeout: 1500 });
        const timer = setTimeout(() => finish(unavailable), 2000);
        function finish(result: GatewayAuthCheck) {
          clearTimeout(timer);
          resolve(result);
          ws.terminate();
        }
        ws.once('open', () => ws.send(JSON.stringify({ id: 1, type: 'hello', token: config.token })));
        ws.once('error', () => finish(unavailable));
        ws.once('close', () => finish(unavailable));
        ws.on('message', (raw) => {
          try {
            const message = JSON.parse(raw.toString());
            if (message.type !== 'response') return;
            if (message.id === 1) {
              if (message.ok) ws.send(JSON.stringify({ id: 2, type: 'gateway.diagnostics' }));
              else finish({ gatewayAuth: 'rejected', activeDeviceCount: 0 });
            } else if (message.id === 2) {
              finish({ gatewayAuth: 'authenticated', activeDeviceCount: message.result?.activeDeviceCount ?? 0 });
            }
          } catch {
            finish(unavailable);
          }
        });
      });
    } catch {
      // Try the next locally bound address.
    }
  }
  return unavailable;
}

interface SystemdOptions {
  nodePath: string;
  entryPath: string;
  workingDirectory: string;
  args?: string[];
  path?: string;
  environmentFile?: string;
}

const SERVICE_NAME = 'uniharn-gateway.service';

function unitValue(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Systemd service options must not contain control characters');
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
}

export function renderSystemdUnit(opts: SystemdOptions): string {
  const command = [opts.nodePath, opts.entryPath, 'gateway', ...(opts.args ?? [])]
    .map((value) => `"${unitValue(value).replaceAll('$', () => '$$')}"`).join(' ');
  return [
    '[Unit]',
    'Description=uniharn gateway',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=exec',
    `WorkingDirectory=${unitValue(opts.workingDirectory)}`,
    `ExecStart=${command}`,
    ...(opts.path ? [`Environment="PATH=${unitValue(opts.path)}"`] : []),
    ...(opts.environmentFile ? [`EnvironmentFile=${unitValue(opts.environmentFile)}`] : []),
    'Restart=on-failure',
    'RestartSec=3',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function userUnitPath(): string {
  if (process.platform !== 'linux' || isRunningAsRoot()) {
    throw new Error('Run this command as a non-root Linux user with a systemd user session');
  }
  const configDir = process.env.XDG_CONFIG_HOME;
  return join(configDir && isAbsolute(configDir) ? configDir : join(homedir(), '.config'), 'systemd', 'user', SERVICE_NAME);
}

function systemctl(...args: string[]): string {
  return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function installSystemdService(opts: SystemdOptions): string {
  const file = userUnitPath();
  const unit = renderSystemdUnit(opts);
  systemctl('show', '--property=Version');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, unit, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  systemctl('daemon-reload');
  systemctl('enable', SERVICE_NAME);
  systemctl('restart', SERVICE_NAME);
  return file;
}

/** Inverse of `renderSystemdUnit`'s quoting: the ExecStart words and the EnvironmentFile path. */
export function parseSystemdUnit(unit: string): { command: string[]; environmentFile: string | null } {
  const unescape = (value: string) => value.replace(/\\(.)|%%|\$\$/g, (match, escaped) => escaped ?? match[0]);
  const exec = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? '';
  const command = [...exec.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => unescape(match[1]));
  const environmentFile = /^EnvironmentFile=(.*)$/m.exec(unit)?.[1];
  return { command, environmentFile: environmentFile ? unescape(environmentFile) : null };
}

/** The master token from a `service.env` written by `uniharn service install`. */
export function parseServiceEnv(text: string): Record<string, string> {
  const match = /^UNIHARN_TOKEN="((?:[^"\\]|\\.)*)"$/m.exec(text);
  return match ? { UNIHARN_TOKEN: match[1].replace(/\\(.)/g, '$1') } : {};
}

/** Arguments and token environment of the installed systemd service, or null when there is none. */
export function readServiceLaunch(): { argv: string[]; env: Record<string, string> } | null {
  try {
    const { command, environmentFile } = parseSystemdUnit(readFileSync(userUnitPath(), 'utf8'));
    if (command.length < 2) return null;
    const env = environmentFile ? parseServiceEnv(readFileSync(environmentFile, 'utf8')) : {};
    return { argv: command, env };
  } catch {
    return null;
  }
}

export function uninstallSystemdService(): boolean {
  const file = userUnitPath();
  if (!existsSync(file)) return false;
  systemctl('disable', '--now', SERVICE_NAME);
  rmSync(file);
  systemctl('daemon-reload');
  return true;
}

export function systemdServiceStatus(): string {
  userUnitPath();
  return systemctl('show', SERVICE_NAME, '--property=LoadState,ActiveState,UnitFileState');
}
