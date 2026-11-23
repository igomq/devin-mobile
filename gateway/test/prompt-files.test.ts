import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/sessions.js';

/** An agent that records the prompt it receives; `embedded` sets promptCapabilities.embeddedContext. */
function recordingAgent(dir: string, embedded: boolean): string {
  const p = join(dir, 'agent');
  writeFileSync(
    p,
    `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize')
    out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: ${embedded} } } } });
  else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 's1' } });
  else if (msg.method === 'session/prompt') {
    fs.writeFileSync(${JSON.stringify(join(dir, 'prompt.json'))}, JSON.stringify(msg.params.prompt));
    out({ id: msg.id, result: { stopReason: 'end_turn' } });
  } else if (msg.id !== undefined) out({ id: msg.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  return p;
}

async function promptWithFile(embedded: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-files-'));
  const m = new SessionManager(recordingAgent(dir, embedded));
  try {
    const s = await m.createSession(dir);
    await m.prompt(s.sessionId, 'read this', [], [{ name: '메모.md', mimeType: 'text/markdown', text: '# 안녕' }]);
    for (let i = 0; i < 50 && s.running; i++) await new Promise((r) => setTimeout(r, 20));
    return JSON.parse(readFileSync(join(dir, 'prompt.json'), 'utf8'));
  } finally {
    m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a text file goes to the agent as an embedded resource when it supports them', async () => {
  const prompt = await promptWithFile(true);
  assert.deepEqual(prompt[0], { type: 'text', text: 'read this' });
  assert.deepEqual(prompt[1], { type: 'resource', resource: { uri: 'attachment:///' + encodeURIComponent('메모.md'), mimeType: 'text/markdown', text: '# 안녕' } });
});

test('a text file goes inline when the agent has no embedded context', async () => {
  const prompt = await promptWithFile(false);
  assert.equal(prompt[1].type, 'text');
  assert.match(prompt[1].text, /<attachment name="메모.md">\n# 안녕\n<\/attachment>/);
  assert.equal(prompt[1]._file, undefined);
});
