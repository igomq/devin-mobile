import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface UsageWindow {
  id: 'daily' | 'weekly';
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
}

export interface DevinUsage {
  plan: string | null;
  windows: UsageWindow[];
  /** Overage balance in dollars when the plan has one. */
  overageBalance: number | null;
  planEndsAt: string | null;
}

/** Where the Devin CLI keeps its login (`devin auth status` prints the same path). */
export function devinCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'devin', 'credentials.toml');
}

export function readDevinCredentials(path = devinCredentialsPath()): { apiKey: string; apiServerUrl: string } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const value = (key: string) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? null;
  const apiKey = value('windsurf_api_key') ?? value('api_key');
  if (!apiKey) return null;
  return { apiKey, apiServerUrl: (value('api_server_url') ?? 'https://server.codeium.com').replace(/\/+$/, '') };
}

const pct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);
const unixToIso = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

/** Reads the quota windows out of a `GetUserStatus` response, honouring the plan's hide flags. */
export function parseDevinUserStatus(body: any): DevinUsage {
  const ps = body?.userStatus?.planStatus ?? {};
  const info = ps.planInfo ?? body?.planInfo ?? {};
  const windows: UsageWindow[] = [];
  const daily = pct(ps.dailyQuotaRemainingPercent);
  if (daily !== null && !info.hideDailyQuota) windows.push({ id: 'daily', label: 'Daily', remainingPercent: daily, resetsAt: unixToIso(ps.dailyQuotaResetAtUnix) });
  const weekly = pct(ps.weeklyQuotaRemainingPercent);
  if (weekly !== null && !info.hideWeeklyQuota) windows.push({ id: 'weekly', label: 'Weekly', remainingPercent: weekly, resetsAt: unixToIso(ps.weeklyQuotaResetAtUnix) });
  const micros = typeof ps.overageBalanceMicros === 'string' ? Number(ps.overageBalanceMicros) : ps.overageBalanceMicros;
  return {
    plan: typeof info.planName === 'string' && info.planName ? info.planName : null,
    windows,
    overageBalance: typeof micros === 'number' && Number.isFinite(micros) && micros > 0 ? micros / 1e6 : null,
    planEndsAt: typeof ps.planEnd === 'string' ? ps.planEnd : null,
  };
}

/**
 * Plan quota as the Devin CLI shows it ("Max · 35% remaining"), from the same user-status call
 * the CLI makes with its stored login. The key stays on the gateway host.
 */
export async function fetchDevinUsage(opts: { credentialsPath?: string; fetchImpl?: typeof fetch; version?: string } = {}): Promise<DevinUsage> {
  const creds = readDevinCredentials(opts.credentialsPath);
  if (!creds) throw new Error('Devin CLI is not logged in on the gateway host.');
  const res = await (opts.fetchImpl ?? fetch)(`${creds.apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: JSON.stringify({ metadata: { apiKey: creds.apiKey, ideName: 'uniharn', ideVersion: opts.version ?? '0', extensionName: 'uniharn', extensionVersion: opts.version ?? '0', locale: 'en' } }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (res.status === 401 || res.status === 403) throw new Error('The Devin login was rejected. Run `devin auth login` on the gateway host.');
  if (!res.ok) throw new Error(`Devin usage request failed (HTTP ${res.status}).`);
  return parseDevinUserStatus(await res.json());
}
