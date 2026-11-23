import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpHarnessAdapter } from '../src/harnesses/acp-generic.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SubagentSettings, noteModels, sessionRefs } from '../src/subagents.js';

/** Agent with a model option that records every set_config_option and the MCP env it got. */
function modelAgent(dir: string, name: string, withModels = true): string {
  const p = join(dir, name);
  const log = join(dir, name + '.log');
  writeFileSync(
    p,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('${name} 1.0.0'); process.exit(0); }
const fs = require('node:fs');
let n = 0;
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const opts = ${withModels} ? [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'big', name: 'Big' }] }] : [];
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (msg.method === 'session/new') {
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ mcp: msg.params.mcpServers }) + '\\n');
    out({ id: msg.id, result: { sessionId: '${name}-' + (++n), configOptions: opts } });
  } else if (msg.method === 'session/set_config_option') {
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ set: msg.params.value }) + '\\n');
    out({ id: msg.id, result: { configOptions: opts.map((o) => ({ ...o, currentValue: msg.params.value })) } });
  } else if (msg.method === 'session/prompt') {
    setTimeout(() => {
      out({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
      out({ id: msg.id, result: { stopReason: 'end_turn' } });
    }, 10);
  } else if (msg.id !== undefined) out({ id: msg.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  return p;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-sub-'));
  const data = join(dir, 'data');
  const registry = new HarnessRegistry(data);
  registry.register(new AcpHarnessAdapter({ id: 'alpha', name: 'alpha', bin: modelAgent(dir, 'alpha'), acpArgs: [] }));
  registry.register(new AcpHarnessAdapter({ id: 'plain', name: 'plain', bin: modelAgent(dir, 'plain', false), acpArgs: [] }));
  const settings = new SubagentSettings(data);
  const orchestrator = new Orchestrator(registry, data, settings);
  const log = (name: string) => readFileSync(join(dir, name + '.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const cleanup = () => {
    for (const h of registry.list()) registry.get(h.id)?.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, data, registry, settings, orchestrator, log, cleanup };
}

test('delegate starts the subagent on the requested model, apart from any chat session model', async () => {
  const { orchestrator, log, cleanup, dir } = setup();
  try {
    const { link, done } = await orchestrator.delegate(null, 'alpha', 'review', { cwd: dir, model: 'big' });
    await done;
    assert.equal(link.model, 'big');
    assert.deepEqual(log('alpha').filter((l) => 'set' in l), [{ set: 'big' }]);
  } finally {
    cleanup();
  }
});

test('delegate falls back to the default subagent model, and persists it', async () => {
  const { orchestrator, settings, data, log, cleanup, dir } = setup();
  try {
    settings.setDefault('alpha', 'big');
    assert.equal(new SubagentSettings(data).defaultModel('alpha'), 'big');
    const { link, done } = await orchestrator.delegate(null, 'alpha', 'review', { cwd: dir });
    await done;
    assert.equal(link.model, 'big');
    assert.deepEqual(log('alpha').filter((l) => 'set' in l), [{ set: 'big' }]);
    const alpha = settings.list().find((s) => s.harnessId === 'alpha');
    assert.deepEqual(alpha?.models.map((m) => m.value), ['small', 'big']);
    settings.setDefault('alpha', null);
    const plain = await orchestrator.delegate(null, 'alpha', 'again', { cwd: dir });
    await plain.done;
    assert.equal(plain.link.model, null);
  } finally {
    cleanup();
  }
});

test('delegate rejects a model for a harness that offers no model choice', async () => {
  const { orchestrator, cleanup, dir } = setup();
  try {
    await assert.rejects(orchestrator.delegate(null, 'plain', 'x', { cwd: dir, model: 'big' }), /does not offer a model choice/);
  } finally {
    cleanup();
  }
});

test('each session gets its own MCP session ref that maps back to it', async () => {
  const { registry, log, cleanup, dir } = setup();
  try {
    registry.setMcpServers((cwd, ref) => [{ name: 'uniharn', command: 'node', args: [], env: [{ name: 'UNIHARN_SESSION_REF', value: ref ?? '' }] }]);
    const s = await registry.createSession('alpha', dir);
    const ref = log('alpha')[0].mcp[0].env[0].value;
    assert.ok(ref);
    assert.deepEqual(sessionRefs.get(ref), { harnessId: 'alpha', sessionId: s.sessionId });
  } finally {
    cleanup();
  }
});

test('noteModels flattens grouped options and ignores sessions without a model option', () => {
  noteModels('grouped', [{ id: 'model', options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }, { value: 'b' }] }] }]);
  noteModels('none', [{ id: 'mode', options: [{ value: 'x' }] }]);
  const settings = new SubagentSettings(mkdtempSync(join(tmpdir(), 'uniharn-sub-')));
  const grouped = settings.list().find((s) => s.harnessId === 'grouped');
  assert.deepEqual(grouped?.models, [{ value: 'a', name: 'A' }, { value: 'b', name: 'b' }]);
  assert.equal(settings.list().some((s) => s.harnessId === 'none'), false);
});
