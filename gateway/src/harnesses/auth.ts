import { execFile } from 'node:child_process';
import type { AuthState, AuthStatus } from './types.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when the command could not be started or timed out. */
  code: number | null;
  error?: string;
}

export type CommandRunner = (bin: string, args: string[], opts?: { timeout?: number; env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

/** Runs a status command and resolves with its output whatever the exit code. */
export const runCommand: CommandRunner = (bin, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout ?? 10_000, env: opts.env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : null;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code, error: e && code === null ? (e.killed ? 'timed out' : e.message) : undefined });
    });
  });

export function authState(status: AuthStatus, patch: Partial<AuthState> = {}): AuthState {
  return { status, method: null, account: [], expiresAt: null, detail: null, checkedAt: new Date().toISOString(), ...patch };
}

export const notInstalled = (bin: string): AuthState => authState('not_installed', { detail: `${bin} was not found on PATH.` });

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const combined = (r: CommandResult) => stripAnsi(`${r.stdout}\n${r.stderr}`);

/** A status command that did not run at all says nothing about the login. */
function failedToRun(r: CommandResult, what: string): AuthState | null {
  if (r.code !== null) return null;
  return authState('error', { detail: `Could not run ${what}: ${r.error ?? 'unknown error'}` });
}

const DEVIN_ACCOUNT_FIELDS = ['Name', 'Email', 'Plan', 'Tier'];

/** `devin auth status` */
export function parseDevinAuthStatus(r: CommandResult): AuthState {
  const failed = failedToRun(r, 'devin auth status');
  if (failed) return failed;
  const out = combined(r);
  if (/expired/i.test(out)) return authState('expired', { method: 'devin auth login', detail: 'The Devin CLI login has expired.' });
  if (/Not logged in/i.test(out)) return authState('unauthenticated', { method: 'devin auth login' });
  if (/^\s*Logged in/im.test(out)) {
    const account: { label: string; value: string }[] = [];
    for (const m of out.matchAll(/^[ \t]+([A-Za-z][A-Za-z ]*?):[ \t]+(.+?)[ \t]*$/gm)) {
      if (DEVIN_ACCOUNT_FIELDS.includes(m[1]) && !account.some((f) => f.label === m[1])) account.push({ label: m[1], value: m[2] });
    }
    const via = out.match(/Logged in \(via ([^)]+)\)/i)?.[1];
    return authState('authenticated', { method: via ?? 'Devin', account });
  }
  return authState('unknown', { detail: 'Unrecognized `devin auth status` output.' });
}

/** `codex login status`: "Logged in using ChatGPT" / "Logged in using an API key - sk-…" / "Not logged in" (exit 1). */
export function parseCodexLoginStatus(r: CommandResult): AuthState {
  const failed = failedToRun(r, 'codex login status');
  if (failed) return failed;
  const out = combined(r);
  if (/expired|re-?authenticate|log in again/i.test(out)) return authState('expired', { detail: 'The Codex login has expired. Run `codex login`.' });
  if (/Not logged in/i.test(out)) return authState('unauthenticated');
  const m = out.match(/Logged in using (ChatGPT|an API key)/i);
  // Only the method is kept: the API-key line includes a key prefix.
  if (m && r.code === 0) return authState('authenticated', { method: /chatgpt/i.test(m[1]) ? 'ChatGPT' : 'API key' });
  return authState('unknown', { detail: 'Unrecognized `codex login status` output.' });
}

/** `claude auth status` prints JSON and exits 1 when logged out. */
export function parseClaudeAuthStatus(r: CommandResult, now = Date.now()): AuthState {
  const failed = failedToRun(r, 'claude auth status');
  if (failed) return failed;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  } catch {
    const out = combined(r);
    if (/Not logged in/i.test(out)) return authState('unauthenticated');
    return authState('unknown', { detail: 'Unrecognized `claude auth status` output.' });
  }
  const str = (k: string) => (typeof j[k] === 'string' && j[k] ? (j[k] as string) : null);
  const expiresAt = str('loginExpiresAt');
  const method = str('authMethod');
  const account = [
    ['Email', str('email')],
    ['Organization', str('orgName')],
    ['Plan', str('subscriptionType') ?? str('planTier')],
  ].filter((f): f is [string, string] => !!f[1]).map(([label, value]) => ({ label, value }));
  if (j.loggedIn !== true) {
    if (expiresAt && Date.parse(expiresAt) <= now) return authState('expired', { method, expiresAt, account });
    return authState('unauthenticated', { method: method === 'none' ? null : method });
  }
  if (expiresAt && Date.parse(expiresAt) <= now) return authState('expired', { method, expiresAt, account, detail: 'The Claude login has expired. Run `claude /login`.' });
  if (method === 'api_key') {
    const source = str('apiKeySource');
    // Claude reports any configured key as logged in without checking it.
    return authState('unknown', { method: source ? `API key (${source})` : 'API key', account, detail: 'An API key is configured but has not been verified.' });
  }
  return authState('authenticated', { method: method === 'claude.ai' ? 'Claude account' : method, expiresAt, account });
}

/** `opencode auth list`: stored credentials, then provider keys found in the environment. */
export function parseOpenCodeAuthList(r: CommandResult): AuthState {
  const failed = failedToRun(r, 'opencode auth list');
  if (failed) return failed;
  const out = combined(r);
  const stored = Number(out.match(/(\d+)\s+credentials?\b/i)?.[1] ?? NaN);
  const envVars = Number(out.match(/(\d+)\s+environment variables?\b/i)?.[1] ?? 0);
  if (Number.isNaN(stored)) return authState('unknown', { detail: 'Unrecognized `opencode auth list` output.' });
  const providers = [...out.matchAll(/^\s*●\s+(.+?)\s+(\S+)\s*$/gm)].map((m) => `${m[1]} (${m[2]})`);
  if (stored > 0) return authState('authenticated', { method: 'opencode auth login', account: providers.length ? [{ label: 'Providers', value: providers.join(', ') }] : [] });
  if (envVars > 0) return authState('unknown', { method: 'Environment', account: [{ label: 'Providers', value: providers.join(', ') }], detail: 'Provider keys come from environment variables and have not been verified.' });
  return authState('unauthenticated', { detail: 'No provider credentials. Only OpenCode’s free models will work.' });
}

/** `kiro-cli whoami --format json`: `{"account":null}` and exit 1 when logged out. */
export function parseKiroWhoami(r: CommandResult): AuthState {
  const failed = failedToRun(r, 'kiro-cli whoami');
  if (failed) return failed;
  const out = combined(r);
  if (/expired/i.test(out)) return authState('expired', { detail: 'The Kiro login has expired. Run `kiro-cli login`.' });
  let account: unknown;
  try {
    account = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).account;
  } catch {
    if (/Not logged in/i.test(out)) return authState('unauthenticated');
    return authState('unknown', { detail: 'Unrecognized `kiro-cli whoami` output.' });
  }
  if (account === null || account === undefined) return authState('unauthenticated');
  if (r.code !== 0) return authState('unknown', { detail: '`kiro-cli whoami` failed.' });
  const a = (typeof account === 'object' ? account : {}) as Record<string, unknown>;
  const fields = Object.entries(a)
    .filter(([k, v]) => typeof v === 'string' && /email|type|region|name|url/i.test(k) && !/token|secret/i.test(k))
    .map(([label, value]) => ({ label, value: value as string }));
  return authState('authenticated', { method: typeof a.accountType === 'string' ? a.accountType : 'Kiro', account: fields });
}

/** True for an agent error that means it needs a login. */
export function isAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /auth(entication|orization)? required|not (logged in|authenticated)|unauthori[sz]ed|invalid api key|login required/i.test(msg);
}
