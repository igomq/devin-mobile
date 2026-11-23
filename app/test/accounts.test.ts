import test from 'node:test';
import assert from 'node:assert/strict';
import { authOf, untilText, usageLine } from '../src/lib/accounts.ts';

test('untilText formats minutes, hours and days, and is empty once passed', () => {
  const now = Date.parse('2026-11-23T00:00:00Z');
  assert.equal(untilText(new Date(now + 12 * 60000).toISOString(), now), '12m');
  assert.equal(untilText(new Date(now + (3 * 60 + 20) * 60000).toISOString(), now), '3h 20m');
  assert.equal(untilText(new Date(now + (6 * 24 + 7) * 3600000).toISOString(), now), '6d 7h');
  assert.equal(untilText(new Date(now - 1000).toISOString(), now), '');
  assert.equal(untilText(null, now), '');
});

test('usageLine shows the remaining share and the reset', () => {
  const now = Date.parse('2026-11-23T00:00:00Z');
  assert.equal(usageLine({ id: 'weekly', label: 'Weekly', remainingPercent: 35, resetsAt: new Date(now + (6 * 24 + 7) * 3600000).toISOString() }, now), '35% left · resets in 6d 7h');
  assert.equal(usageLine({ id: 'daily', label: 'Daily', remainingPercent: 99.6, resetsAt: null }, now), '100% left');
});

test('authOf does not trust the login state of gateways that only send authStatus', () => {
  const base = { id: 'codex', name: 'Codex', version: null, bin: 'codex-acp', enabled: true, custom: false, authMethod: 'codex login', acpSupported: true, acpVersion: 1, capabilities: {} as never, models: [], status: 'running' as const, error: null, installHint: null };
  assert.equal(authOf({ ...base, installed: true, authStatus: 'authenticated' }).status, 'unknown');
  assert.equal(authOf({ ...base, installed: false, authStatus: 'unknown' }).status, 'not_installed');
  const auth = { status: 'expired' as const, method: null, account: [], expiresAt: null, detail: null, checkedAt: null };
  assert.equal(authOf({ ...base, installed: true, authStatus: 'expired', auth }).status, 'expired');
});
