import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevinHarnessAdapter } from '../src/harnesses/devin.js';

function createMockDevinBin(dir: string): string {
  const binPath = join(dir, 'devin');
  const script = `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log('devin 3000.0.0-mock');
  process.exit(0);
}
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  console.log('Logged in as test@example.com');
  process.exit(0);
}
if (process.argv[2] === 'acp') {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  let permResolve = null;
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'devin', title: 'Devin CLI', version: '3000.0.0-mock' },
          agentCapabilities: { sessionCapabilities: { list: true, close: true, delete: true } },
          authMethods: []
        }
      }) + '\\n');
    } else if (msg.method === 'session/new') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { sessionId: 'sess-123', configOptions: [], modes: null }
      }) + '\\n');
    } else if (msg.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working...' } } }
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 77,
        method: 'session/request_permission',
        params: { sessionId: msg.params.sessionId, toolCall: { toolCallId: 'tc-1', title: 'bash' }, options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }] }
      }) + '\\n');
      permResolve = () => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: '_cognition.ai/turn_stats',
          params: { sessionId: msg.params.sessionId, responseDimensions: [{ uid: 'cost', label: 'Tokens', kind: { type: 'metric', value: 42 } }] }
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 5 } }
        }) + '\\n');
      };
    } else if (msg.id === 77 && permResolve) {
      permResolve();
      permResolve = null;
    } else if (msg.method === 'session/close' || msg.method === 'session/delete') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    }
  });
}
`;
  writeFileSync(binPath, script, { mode: 0o755 });
  chmodSync(binPath, 0o755);
  return binPath;
}

test('DevinHarnessAdapter preserves session create, prompt, permission, turn_stats, and delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-devin-reg-'));
  try {
    const bin = createMockDevinBin(dir);
    const adapter = new DevinHarnessAdapter(bin);
    const probed = await adapter.probe();
    assert.equal(probed.installed, true);
    assert.equal(probed.authStatus, 'authenticated');
    assert.equal(probed.version, 'devin 3000.0.0-mock');

    const s = await adapter.createSession(dir);
    assert.equal(s.sessionId, 'sess-123');
    assert.equal(s.harnessId, 'devin');

    const permSeen = new Promise<string>((resolve) => {
      adapter.once('permission', (_sess, p) => resolve(p.requestId));
    });
    const turnEnded = new Promise<void>((resolve) => {
      adapter.on('event', (_sess, ev) => {
        if (ev.update?.sessionUpdate === '_turn_end') resolve();
      });
    });

    await adapter.prompt(s.sessionId, 'hello');
    const reqId = await permSeen;
    adapter.resolvePermission(s.sessionId, reqId, 'allow_once');
    await turnEnded;

    assert.equal(s.tokens.turns, 1);
    assert.equal(s.tokens.inputTokens, 10);
    assert.equal(s.tokens.outputTokens, 20);
    assert.ok(s.turnStats && s.turnStats[0]?.value === 42);

    await adapter.deleteSession(s.sessionId);
    assert.equal(adapter.manager.sessions.has(s.sessionId), false);
    adapter.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
