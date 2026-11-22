import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatScopedSessionId, HarnessRegistry, parseScopedSessionId } from '../src/harnesses/registry.js';
import type { HarnessAdapter, HarnessConfig, HarnessInfo } from '../src/harnesses/types.js';
import { Session } from '../src/sessions.js';

class FakeAdapter extends EventEmitter implements HarnessAdapter {
  custom = false;
  enabled = true;
  bin: string;
  sessions = new Map<string, Session>();

  constructor(public id: string, public name: string) {
    super();
    this.bin = id;
  }

  configure(patch: Partial<HarnessConfig>) {
    if (patch.enabled !== undefined) this.enabled = patch.enabled;
    if (patch.bin) this.bin = patch.bin;
  }

  async probe() {
    return this.info();
  }

  info(): HarnessInfo {
    return {
      id: this.id,
      name: this.name,
      version: '1.0.0',
      bin: this.bin,
      installed: true,
      enabled: this.enabled,
      custom: false,
      authStatus: 'authenticated',
      authMethod: null,
      acpSupported: true,
      acpVersion: 1,
      capabilities: {
        acp: true,
        acpVersion: 1,
        streaming: true,
        models: true,
        reasoningLevels: false,
        modes: false,
        permissions: true,
        mcp: true,
        sessionResume: true,
        sessionClose: true,
        sessionDelete: true,
        subagents: false,
        usage: false,
      },
      models: [],
      status: 'idle',
      error: null,
      installHint: null,
    };
  }

  async ensureReady() {}

  async listSessions() {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  async createSession(cwd: string) {
    const s = new Session('same-id', cwd, this.id);
    s.loaded = true;
    this.sessions.set(s.sessionId, s);
    return s;
  }

  async ensureLoaded(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('not found');
    return s;
  }

  async prompt() {}
  async cancel() {}
  resolvePermission() {}
  async setConfigOption(sessionId: string) {
    return this.sessions.get(sessionId)!.summary();
  }
  async setMode(sessionId: string) {
    return this.sessions.get(sessionId)!.summary();
  }
  async closeSession() {}
  async deleteSession() {}
  stop() {}
}

test('HarnessRegistry prevents session ID collisions and preserves bare Devin IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-reg-test-'));
  try {
    const reg = new HarnessRegistry(dir);
    const devin = new FakeAdapter('devin', 'Devin CLI');
    const claude = new FakeAdapter('claude', 'Claude Code');
    reg.register(devin);
    reg.register(claude);

    await reg.createSession('devin', '/tmp/p1');
    await reg.createSession('claude', '/tmp/p1');

    const all = await reg.listAllSessions();
    assert.equal(all.length, 2);
    const ids = all.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, ['claude:same-id', 'same-id']);

    assert.deepEqual(parseScopedSessionId('same-id', ['devin', 'claude']), { harnessId: 'devin', nativeId: 'same-id' });
    assert.deepEqual(parseScopedSessionId('claude:same-id', ['devin', 'claude']), { harnessId: 'claude', nativeId: 'same-id' });
    assert.equal(formatScopedSessionId('devin', 'abc'), 'abc');
    assert.equal(formatScopedSessionId('claude', 'abc'), 'claude:abc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HarnessRegistry persists harness config and custom ACP definitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-reg-persist-'));
  try {
    const reg1 = new HarnessRegistry(dir);
    reg1.register(new FakeAdapter('devin', 'Devin CLI'));
    reg1.configure('devin', { enabled: false, bin: '/custom/devin' });
    reg1.saveCustomSpec({ id: 'my-agent', name: 'My Agent', command: '/usr/local/bin/my-acp', args: ['--stdio'] });

    const reg2 = new HarnessRegistry(dir);
    const devin2 = new FakeAdapter('devin', 'Devin CLI');
    reg2.register(devin2);
    assert.equal(devin2.info().enabled, false);
    assert.equal(devin2.info().bin, '/custom/devin');
    assert.equal(reg2.listCustomSpecs().length, 1);
    assert.equal(reg2.listCustomSpecs()[0].id, 'my-agent');

    // Built-in IDs are reserved and cannot be overwritten or cleared by removeCustomSpec.
    assert.throws(() => reg2.saveCustomSpec({ id: 'devin', name: 'Fake', command: '/bin/true' }), /reserved/);
    assert.equal(reg2.removeCustomSpec('devin'), false);
    const reg3 = new HarnessRegistry(dir);
    const devin3 = new FakeAdapter('devin', 'Devin CLI');
    reg3.register(devin3);
    assert.equal(devin3.info().enabled, false);
    assert.equal(devin3.info().bin, '/custom/devin');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
