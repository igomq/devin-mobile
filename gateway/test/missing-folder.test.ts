import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, folderPolicy } from '../src/sessions.js';

/** Agent that, like Claude Code, refuses session/load when the session's folder does not exist. */
function strictAgent(dir: string): string {
  const p = join(dir, 'agent');
  writeFileSync(
    p,
    `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (msg.method === 'session/load') {
    if (!fs.existsSync(msg.params.cwd)) return out({ id: msg.id, error: { code: -32602, message: 'Invalid params: cwd does not exist on the machine running the agent: ' + msg.params.cwd } });
    out({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } } } });
    out({ id: msg.id, result: {} });
  } else if (msg.id !== undefined) out({ id: msg.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  return p;
}

test('a session whose folder was deleted still loads its history, with the folder recreated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-gone-'));
  const m = new SessionManager(strictAgent(dir));
  try {
    const gone = join(dir, 'deleted-project');
    const s = await m.ensureLoaded('s1', gone);
    assert.ok(existsSync(gone));
    assert.equal(s.summary().folderMissing, true);
    assert.ok(s.events.some((e) => e.update?.content?.text === 'old reply'));
  } finally {
    m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing folder the policy does not allow is not created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-gone-'));
  const m = new SessionManager(strictAgent(dir));
  const prev = folderPolicy.mayRecreate;
  folderPolicy.mayRecreate = () => false;
  try {
    const gone = join(dir, 'outside');
    await assert.rejects(m.ensureLoaded('s1', gone), /cwd does not exist/);
    assert.equal(existsSync(gone), false);
  } finally {
    folderPolicy.mayRecreate = prev;
    m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
