import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/sessions.js';

/** An agent that supports session/load and session/close. */
function closingAgent(dir: string): string {
  const p = join(dir, 'agent');
  writeFileSync(
    p,
    `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let n = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } } });
  else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 's' + ++n } });
  else if (msg.id !== undefined) out({ id: msg.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  return p;
}

test('the agent is stopped once every session it holds is idle and unwatched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-idle-'));
  const m = new SessionManager(closingAgent(dir));
  try {
    const a = await m.createSession(dir);
    const b = await m.createSession(dir);
    (m as any).sessions.get(a.sessionId).updatedAt = Date.now() - 10 * 60_000;
    assert.equal(await m.releaseIdle(() => false, 2 * 60_000), 0, 'b is still fresh');
    (m as any).sessions.get(b.sessionId).updatedAt = Date.now() - 10 * 60_000;
    assert.equal(await m.releaseIdle((id) => id === b.sessionId, 2 * 60_000), 0, 'b is open in the app');

    (m as any).sessions.get(b.sessionId).updatedAt = Date.now() - 10 * 60_000;
    assert.equal(await m.releaseIdle(() => false, 2 * 60_000), 2);
    for (let i = 0; i < 50 && (m as any).sessions.get(a.sessionId).loaded; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((m as any).sessions.get(a.sessionId).loaded, false);
    assert.equal(m.agentError, null);
  } finally {
    m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
