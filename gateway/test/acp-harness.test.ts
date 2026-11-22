import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpHarnessAdapter, filterEnv, resolveBin } from '../src/harnesses/acp-generic.js';
import { BUILTIN_ACP_SPECS, createCustomAcpAdapter } from '../src/harnesses/builtins.js';
import { HarnessRegistry, formatScopedSessionId } from '../src/harnesses/registry.js';

function mockAcpBin(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('${name} 1.0.0'); process.exit(0); }
if (process.argv[2] !== 'acp') process.exit(2);
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentInfo: { name: '${name}', version: '1.0.0' }, agentCapabilities: { loadSession: true, sessionCapabilities: { close: true } }, authMethods: [] } });
  else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 'native-1', env: process.env.SECRET_TOKEN ?? null } });
  else if (msg.method === 'session/prompt') {
    out({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } });
    out({ id: msg.id, result: { stopReason: 'end_turn' } });
  } else if (msg.id !== undefined) out({ id: msg.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  chmodSync(p, 0o755);
  return p;
}

test('AcpHarnessAdapter drives an ACP agent and negotiates capabilities from initialize', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-acp-h-'));
  const adapter = new AcpHarnessAdapter({ id: 'opencode', name: 'OpenCode', bin: mockAcpBin(dir, 'opencode'), acpArgs: ['acp'] });
  try {
    const info = await adapter.probe();
    assert.equal(info.installed, true);
    assert.equal(info.version, 'opencode 1.0.0');
    assert.equal(info.capabilities.sessionResume, false);
    const s = await adapter.createSession(dir);
    assert.equal(s.harnessId, 'opencode');
    assert.equal(formatScopedSessionId('opencode', s.sessionId), 'opencode:native-1');
    const after = adapter.info();
    assert.equal(after.status, 'running');
    assert.equal(after.capabilities.sessionResume, true);
    assert.equal(after.capabilities.sessionClose, true);
    assert.equal(after.acpVersion, 1);
    const chunks: string[] = [];
    adapter.on('event', (_s, ev) => ev.kind === 'message' && chunks.push(ev.text ?? ''));
    await adapter.prompt(s.sessionId, 'hello');
  } finally {
    adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Unverified built-ins start disabled and missing binaries report unavailable', async () => {
  for (const spec of BUILTIN_ACP_SPECS.filter((s) => s.verified === false)) {
    const a = new AcpHarnessAdapter({ ...spec, bin: '/nonexistent/' + spec.bin });
    const info = await a.probe();
    assert.equal(info.enabled, false);
    assert.equal(info.installed, false);
    assert.equal(info.status, 'unavailable');
    assert.ok(info.error);
  }
});

test('filterEnv keeps only base keys plus the allowlist', () => {
  const env = filterEnv(['FOO'], { PATH: '/bin', FOO: '1', SECRET_TOKEN: 'x' });
  assert.deepEqual(env, { PATH: '/bin', FOO: '1' });
  assert.equal(filterEnv([], { A: '1' }).A, '1');
});

test('Registry instantiates custom ACP adapters from persisted definitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-custom-'));
  try {
    const r1 = new HarnessRegistry(dir);
    r1.setCustomFactory(createCustomAcpAdapter);
    r1.saveCustomSpec({ id: 'my-agent', name: 'My Agent', command: '/usr/bin/my-acp', args: ['--stdio'] });
    assert.equal(r1.get('my-agent')?.custom, true);
    const r2 = new HarnessRegistry(dir);
    r2.setCustomFactory(createCustomAcpAdapter);
    assert.equal(r2.get('my-agent')?.info().name, 'My Agent');
    assert.equal(r2.removeCustomSpec('my-agent'), true);
    assert.equal(r2.get('my-agent'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBin skips non-executable PATH matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-bin-'));
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, 'tool'), 'not executable', { mode: 0o644 });
    writeFileSync(join(b, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(resolveBin('tool', { PATH: [a, b].join(':') }), join(b, 'tool'));
    assert.equal(resolveBin(join(a, 'tool')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listAllSessions does not wait for a stalled harness and reports its rows later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-slow-'));
  const registry = new HarnessRegistry(dir);
  const fast = new AcpHarnessAdapter({ id: 'fast', name: 'fast', bin: mockAcpBin(dir, 'fast'), acpArgs: ['acp'] });
  const slow = new AcpHarnessAdapter({ id: 'slow', name: 'slow', bin: mockAcpBin(dir, 'slow'), acpArgs: ['acp'] });
  let release!: (rows: any[]) => void;
  slow.listSessions = () => new Promise((r) => (release = r));
  registry.register(fast);
  registry.register(slow);
  const t = mock.timers;
  try {
    await registry.probeAll();
    const late: any[] = [];
    registry.on('state', (s) => late.push(s));
    t.enable({ apis: ['setTimeout'] });
    const listing = registry.listAllSessions();
    await new Promise((r) => setImmediate(r));
    t.tick(10_000);
    t.reset();
    assert.deepEqual(await listing, []);
    release([{ sessionId: 'x', harnessId: 'slow', updatedAt: 1 }]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(late.map((s) => [s.harnessId, s.sessionId]), [['slow', 'x']]);
  } finally {
    t.reset();
    fast.stop();
    slow.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
