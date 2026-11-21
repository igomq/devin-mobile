import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  hosts: string[];
  port: number;
  devinBin: string;
  devinArgs: string[];
  dataDir: string;
  roots: string[];
  staticDir: string | null;
  token: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const pref = process.argv.find((a) => a.startsWith(`--${name}=`));
  return pref ? pref.slice(name.length + 3) : undefined;
}

export function tailscaleIPv4(): string | null {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    return out.split('\n')[0] || null;
  } catch {
    return null;
  }
}

function findDevin(): string {
  const candidates = [process.env.DEVIN_BIN, join(homedir(), '.local/bin/devin'), '/usr/local/bin/devin', '/opt/homebrew/bin/devin'];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return 'devin';
}

export function loadConfig(): Config {
  const dataDir = resolve(arg('data-dir') ?? process.env.DEVIN_MOBILE_DATA_DIR ?? join(homedir(), '.local/share/devin-mobile'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(dataDir, 'token');
  let token = process.env.DEVIN_MOBILE_TOKEN ?? '';
  if (!token) {
    if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    token = readFileSync(tokenFile, 'utf8').trim();
  }

  // Never bind to all interfaces by default: loopback (for `tailscale serve`) plus the Tailscale IP if present.
  const hostArg = arg('host') ?? process.env.DEVIN_MOBILE_HOST;
  let hosts: string[];
  if (hostArg) hosts = hostArg.split(',').map((h) => h.trim()).filter(Boolean);
  else {
    hosts = ['127.0.0.1'];
    const ts = tailscaleIPv4();
    if (ts) hosts.push(ts);
  }

  const rootsArg = arg('roots') ?? process.env.DEVIN_MOBILE_ROOTS;
  const roots = rootsArg ? rootsArg.split(',').map((r) => resolve(r.trim())) : [homedir(), join(homedir(), 'repos'), join(homedir(), 'projects'), join(homedir(), 'code')];

  const defaultStatic = resolve(new URL('.', import.meta.url).pathname, '../../app/build');
  const staticArg = arg('static') ?? process.env.DEVIN_MOBILE_STATIC;
  const staticDir = staticArg === 'none' ? null : resolve(staticArg ?? defaultStatic);

  const devinArgs: string[] = [];
  const model = arg('model') ?? process.env.DEVIN_MOBILE_MODEL;
  if (model) devinArgs.push('--model', model);

  return {
    hosts,
    port: Number(arg('port') ?? process.env.DEVIN_MOBILE_PORT ?? 8787),
    devinBin: arg('devin') ?? findDevin(),
    devinArgs,
    dataDir,
    roots,
    staticDir: staticDir && existsSync(staticDir) ? staticDir : null,
    token,
  };
}
