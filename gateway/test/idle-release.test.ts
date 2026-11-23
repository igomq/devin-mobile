import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/sessions.js';

/** An agent that supports session/close and logs each call to `closed.log`. */
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
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } } });
  else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 's' + ++n } });
  else if (msg.method === 'session/close') {
    fs.appendFileSync(${JSON.stringify(join(dir, 'closed.log'))}, msg.params.sessionId + '\\n');
    out({ id: msg.id, result: {} });
  } else if (msg.id !== undefined) out({ id: msg.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  return p;
}

test('idle sessions nobody is watching are closed so other apps can open them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-idle-'));
  const m = new SessionManager(closingAgent(dir));
  try {
    const watched = await m.createSession(dir);
    const idle = await m.createSession(dir);
    const fresh = await m.createSession(dir);
    for (const s of [watched, idle]) (m as any).sessions.get(s.sessionId).updatedAt = Date.now() - 10 * 60_000;

    const released = await m.releaseIdle((id) => id === watched.sessionId, 2 * 60_000);

    assert.equal(released, 1);
    assert.equal(readFileSync(join(dir, 'closed.log'), 'utf8'), idle.sessionId + '\n');
    assert.equal((m as any).sessions.get(idle.sessionId).loaded, false);
    assert.equal((m as any).sessions.get(watched.sessionId).loaded, true);
    assert.equal((m as any).sessions.get(fresh.sessionId).loaded, true);
  } finally {
    m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
