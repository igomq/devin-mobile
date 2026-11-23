import type { AuthStatus, HarnessInfo, UsageWindow } from './types.ts';

export const AUTH_LABEL: Record<AuthStatus, string> = {
  authenticated: 'Logged in',
  unauthenticated: 'Not logged in',
  expired: 'Login expired',
  not_installed: 'Not installed',
  error: 'Check failed',
  unknown: 'Unknown'
};

/** Older gateways send only `authStatus` (and derived it from the process state, so it is not trusted as a login). */
export function authOf(h: HarnessInfo) {
  return h.auth ?? { status: h.installed ? 'unknown' : 'not_installed', method: null, account: [], expiresAt: null, detail: 'Update the gateway to see this harness’s login state.', checkedAt: null };
}

/** "6d 7h", "3h 20m", "12m" until `iso`; empty once it has passed. */
export function untilText(iso: string | null, now = Date.now()) {
  if (!iso) return '';
  const m = Math.floor((new Date(iso).getTime() - now) / 60000);
  if (!(m > 0)) return '';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "Weekly 35% left · resets in 6d 7h" */
export function usageLine(w: UsageWindow, now = Date.now()) {
  const reset = untilText(w.resetsAt, now);
  return `${Math.round(w.remainingPercent)}% left${reset ? ` · resets in ${reset}` : ''}`;
}
