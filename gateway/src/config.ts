import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  hosts: string[];
  port: number;
  devinBin: string;
  devinArgs: string[];
  dataDir: string;
  legacyMigrated: boolean;
  roots: string[];
  staticDir: string | null;
  token: string;
}

function normalizeArgv(argv: string[]): string[] {
  // Support `uniharn gateway [flags...]` as well as direct `uniharn-gateway [flags...]`.
  if (argv[2] === 'gateway') return [argv[0], argv[1], ...argv.slice(3)];
  return argv;
}

function getArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(`--${name}=`));
  return pref ? pref.slice(name.length + 3) : undefined;
}

function getEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`UNIHARN_${suffix}`] ?? env[`DEVIN_MOBILE_${suffix}`];
}

export function tailscaleIPv4(): string | null {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    return out.split('\n')[0] || null;
  } catch {
    return null;
  }
}

function findDevin(env: NodeJS.ProcessEnv, home: string): string {
  const candidates = [env.UNIHARN_DEVIN_BIN, env.DEVIN_BIN, join(home, '.local/bin/devin'), '/usr/local/bin/devin', '/opt/homebrew/bin/devin'];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return 'devin';
}

export interface LoadConfigOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  detectTailscale?: () => string | null;
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const argv = normalizeArgv(opts.argv ?? process.argv);
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const detectTs = opts.detectTailscale ?? tailscaleIPv4;

  const explicitDataDir = getArg(argv, 'data-dir') ?? getEnv(env, 'DATA_DIR');
  const defaultDataDir = join(home, '.local/share/uniharn');
  const legacyDataDir = join(home, '.local/share/devin-mobile');
  const dataDir = resolve(explicitDataDir ?? defaultDataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const tokenFile = join(dataDir, 'token');
  let legacyMigrated = false;

  // Automatically migrate legacy token when using default uniharn data dir and no token exists yet.
  if (!explicitDataDir && !existsSync(tokenFile)) {
    const legacyTokenFile = join(legacyDataDir, 'token');
    if (existsSync(legacyTokenFile)) {
      copyFileSync(legacyTokenFile, tokenFile);
      chmodSync(tokenFile, 0o600);
      legacyMigrated = true;
    }
  }

  let token = getEnv(env, 'TOKEN') ?? '';
  if (!token) {
    if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    token = readFileSync(tokenFile, 'utf8').trim();
  }

  // Never bind to all interfaces by default: loopback (for `tailscale serve`) plus the Tailscale IP if present.
  const hostArg = getArg(argv, 'host') ?? getEnv(env, 'HOST');
  let hosts: string[];
  if (hostArg) hosts = hostArg.split(',').map((h) => h.trim()).filter(Boolean);
  else {
    hosts = ['127.0.0.1'];
    const ts = detectTs();
    if (ts) hosts.push(ts);
  }

  const rootsArg = getArg(argv, 'roots') ?? getEnv(env, 'ROOTS');
  const roots = rootsArg ? rootsArg.split(',').map((r) => resolve(r.trim())) : [home, join(home, 'repos'), join(home, 'projects'), join(home, 'code')];

  const defaultStatic = resolve(new URL('.', import.meta.url).pathname, '../../app/build');
  const staticArg = getArg(argv, 'static') ?? getEnv(env, 'STATIC');
  const staticDir = staticArg === 'none' ? null : resolve(staticArg ?? defaultStatic);

  const devinArgs: string[] = [];
  const model = getArg(argv, 'model') ?? getEnv(env, 'MODEL');
  if (model) devinArgs.push('--model', model);

  return {
    hosts,
    port: Number(getArg(argv, 'port') ?? getEnv(env, 'PORT') ?? 8787),
    devinBin: getArg(argv, 'devin') ?? findDevin(env, home),
    devinArgs,
    dataDir,
    legacyMigrated,
    roots,
    staticDir: staticDir && existsSync(staticDir) ? staticDir : null,
    token,
  };
}
