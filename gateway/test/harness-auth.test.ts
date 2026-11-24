import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CommandResult, type CommandRunner, isAuthError, parseClaudeAuthStatus, parseCodexLoginStatus,
  parseDevinAuthStatus, parseGrokModelsAuth, parseKiroWhoami, parseOpenCodeAuthList,
} from '../src/harnesses/auth.js';
import { AcpHarnessAdapter } from '../src/harnesses/acp-generic.js';
import { BUILTIN_ACP_SPECS } from '../src/harnesses/builtins.js';
import { DevinHarnessAdapter } from '../src/harnesses/devin.js';
import { fetchDevinUsage, parseDevinUserStatus, readDevinCredentials } from '../src/harnesses/devin-usage.js';

const ok = (stdout: string, code: number | null = 0, stderr = ''): CommandResult => ({ stdout, stderr, code });

test('Devin auth status: logged in with account fields, logged out, expired, unrecognized, failed to run', () => {
  const s = parseDevinAuthStatus(ok('Logged in (via Devin).\n\nUser:\n  Name:              Ada\n  Email:             ada@example.com\n  User ID:           user-1\n\nAccount:\n  Tier:              Devin Max\n  Plan:              Max\n'));
  assert.equal(s.status, 'authenticated');
  assert.equal(s.method, 'Devin');
  assert.deepEqual(s.account.map((f) => f.label), ['Name', 'Email', 'Tier', 'Plan']);
  assert.equal(parseDevinAuthStatus(ok('Not logged in. Run devin auth login.', 1)).status, 'unauthenticated');
  assert.equal(parseDevinAuthStatus(ok('Your session has expired. Log in again.', 1)).status, 'expired');
  assert.equal(parseDevinAuthStatus(ok('something else')).status, 'unknown');
  assert.equal(parseDevinAuthStatus({ stdout: '', stderr: '', code: null, error: 'timed out' }).status, 'error');
});

test('Codex login status keeps only the method, never the key prefix', () => {
  assert.deepEqual([parseCodexLoginStatus(ok('Logged in using ChatGPT')).status, parseCodexLoginStatus(ok('Logged in using ChatGPT')).method], ['authenticated', 'ChatGPT']);
  const key = parseCodexLoginStatus(ok('Logged in using an API key - sk-proj-***abcd'));
  assert.equal(key.method, 'API key');
  assert.ok(!JSON.stringify(key).includes('sk-'));
  assert.equal(parseCodexLoginStatus(ok('', 1, 'Not logged in')).status, 'unauthenticated');
  assert.equal(parseCodexLoginStatus(ok('Logged in using ChatGPT', 1)).status, 'unknown');
});

test('Claude auth status distinguishes account logins, unverified API keys, logged out and expired', () => {
  const now = Date.parse('2026-11-23T00:00:00Z');
  const json = (o: object, code = 0) => ok(JSON.stringify(o), code);
  const s = parseClaudeAuthStatus(json({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', subscriptionType: 'pro', loginExpiresAt: '2026-12-22T19:13:47.762Z' }), now);
  assert.equal(s.status, 'authenticated');
  assert.equal(s.method, 'Claude account');
  assert.deepEqual(s.account, [{ label: 'Email', value: 'a@b.c' }, { label: 'Plan', value: 'pro' }]);
  assert.equal(parseClaudeAuthStatus(json({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: '2026-11-01T00:00:00Z' }), now).status, 'expired');
  const key = parseClaudeAuthStatus(json({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }), now);
  assert.equal(key.status, 'unknown');
  assert.equal(key.method, 'API key (ANTHROPIC_API_KEY)');
  const out = parseClaudeAuthStatus(json({ loggedIn: false, authMethod: 'none', loginExpiresAt: null }, 1), now);
  assert.equal(out.status, 'unauthenticated');
  assert.equal(out.method, null);
  assert.equal(parseClaudeAuthStatus(ok('Not logged in. Run claude auth login to authenticate.', 1), now).status, 'unauthenticated');
});

test('OpenCode auth list counts stored credentials and treats environment keys as unverified', () => {
  const stored = '\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n●  Anthropic \x1b[90mapi\n│\n└  1 credentials\n';
  const s = parseOpenCodeAuthList(ok(stored));
  assert.equal(s.status, 'authenticated');
  assert.deepEqual(s.account, [{ label: 'Providers', value: 'Anthropic (api)' }]);
  const env = '┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n\n┌  Environment\n│\n●  OpenRouter OPENROUTER_API_KEY\n│\n└  1 environment variable\n';
  assert.equal(parseOpenCodeAuthList(ok(env)).status, 'unknown');
  assert.equal(parseOpenCodeAuthList(ok('┌  Credentials ~/x\n│\n└  0 credentials\n')).status, 'unauthenticated');
});

test('Kiro whoami: null account is logged out, an account is logged in', () => {
  assert.equal(parseKiroWhoami(ok('{"account":null}', 1)).status, 'unauthenticated');
  const s = parseKiroWhoami(ok('{"account":{"accountType":"BuilderId","email":"k@x.y","accessToken":"t"}}'));
  assert.equal(s.status, 'authenticated');
  assert.equal(s.method, 'BuilderId');
  assert.ok(!JSON.stringify(s).includes('accessToken'));
  assert.equal(parseKiroWhoami(ok('Not logged in', 1)).status, 'unauthenticated');
});

test('Grok models probe reads the sign-in line, not just the exit code', () => {
  const signedOut = 'You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n';
  assert.equal(parseGrokModelsAuth(ok(signedOut)).status, 'unauthenticated');
  assert.equal(parseGrokModelsAuth(ok('You are logged in with XAI_API_KEY\n\nAvailable models:\n  * grok-4.6\n')).status, 'authenticated');
  assert.equal(parseGrokModelsAuth(ok('\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n')).status, 'authenticated');
  assert.equal(parseGrokModelsAuth(ok('', 1, 'Not logged in')).status, 'unauthenticated');
  assert.equal(parseGrokModelsAuth(ok('', 1, 'invalid api key')).status, 'unauthenticated');
  assert.equal(parseGrokModelsAuth({ stdout: '', stderr: '', code: null, error: 'timed out' }).status, 'error');
});

test('isAuthError recognizes agent login errors only', () => {
  assert.ok(isAuthError(new Error('Authentication required')));
  assert.ok(isAuthError(new Error('Not logged in')));
  assert.ok(!isAuthError(new Error('Session not found')));
});

function exe(dir: string, name: string, body = 'process.exit(0)'): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

const acpAgent = (sessionNew: string) => `
if (process.argv[2] === '--version') { console.log('1.0.0'); process.exit(0); }
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (msg.method === 'session/new') out({ id: msg.id, ${sessionNew} });
  else if (msg.id !== undefined) out({ id: msg.id, result: {} });
});`;

test('ACP harness: a configured executable path is also used for the login check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-auth-'));
  const calls: string[][] = [];
  const run: CommandRunner = async (bin, args) => (calls.push([bin, ...args]), ok('{"account":null}', 1));
  const adapter = new AcpHarnessAdapter(BUILTIN_ACP_SPECS.find((s) => s.id === 'kiro')!, run);
  try {
    const custom = exe(dir, 'my-kiro');
    adapter.configure({ bin: custom });
    const info = await adapter.probe();
    assert.equal(info.auth.status, 'unauthenticated');
    assert.deepEqual(calls[0], [custom, 'whoami', '--format', 'json']);
  } finally {
    adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ACP harness: login state comes from the status command, not from the running process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-auth-'));
  const calls: string[][] = [];
  let reply = ok('Not logged in', 1);
  const run: CommandRunner = async (bin, args) => (calls.push([bin, ...args]), reply);
  const status = exe(dir, 'codex');
  const spec = { ...BUILTIN_ACP_SPECS.find((s) => s.id === 'codex')!, bin: exe(dir, 'codex-acp', acpAgent("result: { sessionId: 'n1' }")) };
  const adapter = new AcpHarnessAdapter({ ...spec, authCheck: { ...spec.authCheck!, bin: status } }, run);
  try {
    let info = await adapter.probe();
    assert.equal(info.authStatus, 'unauthenticated');
    assert.deepEqual(calls[0], [status, 'login', 'status']);
    await adapter.createSession(dir);
    info = adapter.info();
    assert.equal(info.status, 'running');
    assert.equal(info.authStatus, 'unauthenticated', 'a running agent is not proof of a login');
    reply = ok('Logged in using ChatGPT');
    info = await adapter.probe();
    assert.equal(info.auth.status, 'authenticated');
    assert.equal(info.auth.method, 'ChatGPT');
  } finally {
    adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ACP harness: missing CLI, missing status command, no status command, and an agent auth error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-auth-'));
  const run: CommandRunner = async () => assert.fail('no status command should run');
  const missing = new AcpHarnessAdapter({ id: 'kiro', name: 'Kiro', bin: join(dir, 'nope'), acpArgs: ['acp'], authCheck: { bin: 'kiro-cli', args: [], parse: parseKiroWhoami } }, run);
  assert.equal((await missing.probe()).authStatus, 'not_installed');

  const noStatusBin = new AcpHarnessAdapter({ id: 'claude', name: 'Claude', bin: exe(dir, 'agent'), acpArgs: [], authCheck: { bin: join(dir, 'no-claude'), args: [], parse: parseClaudeAuthStatus } }, run);
  const a = await noStatusBin.probe();
  assert.equal(a.authStatus, 'unknown');
  assert.match(a.auth.detail ?? '', /not found/);

  const custom = new AcpHarnessAdapter({ id: 'mine', name: 'Mine', bin: exe(dir, 'mine', acpAgent("error: { code: -32000, message: 'Authentication required' }")), acpArgs: [], custom: true }, run);
  try {
    assert.equal((await custom.probe()).authStatus, 'unknown');
    await assert.rejects(custom.createSession(dir), /Authentication required/);
    const info = custom.info();
    assert.equal(info.authStatus, 'unauthenticated');
    assert.match(info.auth.detail ?? '', /asked for a login/);
  } finally {
    custom.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Devin harness reports not_installed and parses auth status through the runner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-auth-'));
  try {
    const missing = new DevinHarnessAdapter(join(dir, 'devin-missing'), [], async () => assert.fail('not run'));
    assert.equal((await missing.probe()).authStatus, 'not_installed');
    const devin = new DevinHarnessAdapter(exe(dir, 'devin', "console.log('devin 1.0'); process.exit(0)"), [], async () => ok('Not logged in', 1));
    const info = await devin.probe();
    assert.equal(info.installed, true);
    assert.equal(info.authStatus, 'unauthenticated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Devin usage: parses quota windows, honours hide flags, and keeps the key on the host', async () => {
  const body = { userStatus: { planStatus: { planInfo: { planName: 'Max', hideDailyQuota: true }, dailyQuotaRemainingPercent: 100, weeklyQuotaRemainingPercent: 35, weeklyQuotaResetAtUnix: '1795939200', overageBalanceMicros: '-248846', planEnd: '2026-12-21T01:14:49Z' } } };
  const u = parseDevinUserStatus(body);
  assert.equal(u.plan, 'Max');
  assert.deepEqual(u.windows, [{ id: 'weekly', label: 'Weekly', remainingPercent: 35, resetsAt: new Date(1795939200 * 1000).toISOString() }]);
  assert.equal(u.overageBalance, null);

  const dir = mkdtempSync(join(tmpdir(), 'uniharn-usage-'));
  try {
    const credentialsPath = join(dir, 'credentials.toml');
    assert.equal(readDevinCredentials(credentialsPath), null);
    writeFileSync(credentialsPath, 'windsurf_api_key = "secret-key"\napi_server_url = "https://api.example.test/"\n');
    let seen: { url: string; body: any } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await fetchDevinUsage({ credentialsPath, fetchImpl });
    assert.equal(got.windows[0].remainingPercent, 35);
    assert.equal(seen!.url, 'https://api.example.test/exa.seat_management_pb.SeatManagementService/GetUserStatus');
    assert.equal(seen!.body.metadata.apiKey, 'secret-key');
    const rejected = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(fetchDevinUsage({ credentialsPath, fetchImpl: rejected }), /rejected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
