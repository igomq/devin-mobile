import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpHarnessAdapter } from '../src/harnesses/acp-generic.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SubagentSettings } from '../src/subagents.js';

function nativeAgent(dir: string): string {
  const p = join(dir, 'native-agent');
  const log = join(dir, 'native-agent.log');
  writeFileSync(
    p,
    `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const rec = (x) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(x) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    rec({ init: msg.params });
    out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { steering: { supported: true } } } });
  } else if (msg.method === 'session/new') {
    out({ id: msg.id, result: { sessionId: 'parent-1', modes: { currentModeId: 'agent', availableModes: [{ id: 'read-only', name: 'Read only' }, { id: 'agent', name: 'Agent' }, { id: 'manual', name: 'Manual' }] }, configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'big', name: 'Big' }] }, { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] }, { id: 'fast', type: 'boolean', currentValue: false }] } });
  } else if (msg.method === 'session/load') {
    rec({ load: msg.params.sessionId });
    out({ id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    if (sid === 'parent-1') {
      out({ method: 'session/update', params: { sessionId: 'parent-1', update: { sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Child worker', description: 'Reviews the diff', cwd: ${JSON.stringify(dir)}, state: { state: 'running' }, capabilities: { cancel: {} } } } });
      out({ method: 'session/update', params: { sessionId: 'child-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child is working' } } } });
      out({ id: 'perm-child', method: 'session/request_permission', params: { sessionId: 'child-1', toolCall: { toolCallId: 'tool-1', title: 'Run command' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } });
    }
    out({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'parent reply' } } } });
    out({ id: msg.id, result: { stopReason: 'end_turn' } });
  } else if (msg.method === '_session/steering') {
    rec({ steering: msg.params });
    out({ id: msg.id, result: { outcome: 'injected' } });
  } else if (msg.method && msg.id === undefined) {
    rec({ method: msg.method, params: msg.params });
  } else if (msg.id !== undefined && !msg.method) {
    // Response to an agent-initiated request.
  } else if (msg.id !== undefined) {
    rec({ method: msg.method, params: msg.params });
    out({ id: msg.id, result: {} });
  }
});
`,
    { mode: 0o755 },
  );
  chmodSync(p, 0o755);
  return p;
}

function policyAgent(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  const log = join(dir, name + '.log');
  writeFileSync(
    p,
    `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const rec = (x) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(x) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  ${body}
});
`,
    { mode: 0o755 },
  );
  chmodSync(p, 0o755);
  return p;
}

const readLog = (path: string) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('ACP initialize advertises subagents and urgent messages use steering when supported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-native-'));
  const adapter = new AcpHarnessAdapter({ id: 'native', name: 'native', bin: nativeAgent(dir), acpArgs: [] });
  try {
    const s = await adapter.createSession(dir);
    const result = await adapter.steer(s.sessionId, 'Please prioritize the failing test');
    assert.equal(result.mode, 'steering');
    assert.equal(result.outcome, 'injected');
    const log = readLog(join(dir, 'native-agent.log'));
    assert.equal(log.find((x) => x.init)?.init?.clientCapabilities?.subagents !== undefined, true);
    const steering = log.find((x) => x.steering);
    assert.equal(steering?.steering?.sessionId, s.sessionId);
    assert.equal(steering?.steering?._meta?.steering?.idleBehavior, 'promptRequired');
  } finally {
    adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subagent_update creates a routed child without session/load or top-level listing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-native-child-'));
  const adapter = new AcpHarnessAdapter({ id: 'native', name: 'native', bin: nativeAgent(dir), acpArgs: [] });
  try {
    const parent = await adapter.createSession(dir);
    await adapter.prompt(parent.sessionId, 'start');
    await new Promise((r) => setTimeout(r, 10));
    const children = adapter.listNativeSubagents();
    assert.equal(children.length, 1);
    const child = children[0].child;
    assert.equal(children[0].parentSessionId, parent.sessionId);
    assert.equal(child.sessionId, 'child-1');
    assert.equal(child.subagent?.title, 'Child worker');
    assert.equal(child.status, 'awaiting_permission');
    const listed = await adapter.listSessions(dir);
    assert.deepEqual(listed.map((s) => s.sessionId), [parent.sessionId]);
    const log = readLog(join(dir, 'native-agent.log'));
    assert.equal(log.some((x) => x.load === 'child-1'), false);
    await assert.rejects(adapter.prompt('child-1', 'hello'), /cannot be prompted/i);
    await adapter.cancel('child-1');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(readLog(join(dir, 'native-agent.log')).some((x) => x.method === 'session/cancel' && x.params?.sessionId === 'child-1'), true);
  } finally {
    adapter.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delegation applies autonomous mode and configured effort before prompting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-policy-'));
  const data = join(dir, 'data');
  const bin = policyAgent(
    dir,
    'policy-agent',
    `if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 'del-1', configOptions: [
  { id: 'model', category: 'model', type: 'select', currentValue: 'small', options: [{ value: 'small' }, { value: 'big' }] },
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'manual', options: [{ value: 'manual', name: 'Manual' }, { value: 'auto', name: 'Auto' }] },
  { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] }
] } });
else if (msg.method === 'session/set_config_option') { rec({ set: msg.params.configId, value: msg.params.value }); out({ id: msg.id, result: { configOptions: [{ id: 'mode', category: 'mode', type: 'select', currentValue: 'auto', options: [{ value: 'manual' }, { value: 'auto' }] }, { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] }] } }); }
else if (msg.method === 'session/prompt') { out({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } }); out({ id: msg.id, result: { stopReason: 'end_turn' } }); }
else if (msg.id !== undefined) out({ id: msg.id, result: {} });`,
  );
  const registry = new HarnessRegistry(data);
  registry.register(new AcpHarnessAdapter({ id: 'policy', name: 'policy', bin, acpArgs: [] }));
  const settings = new SubagentSettings(data);
  settings.setPolicy('policy', { config: { effort: 'high' } });
  const orchestrator = new Orchestrator(registry, data, settings);
  try {
    const { done } = await orchestrator.delegate(null, 'policy', 'review', { cwd: dir });
    await done;
    const sets = readLog(join(dir, 'policy-agent.log')).filter((x) => x.set);
    assert.deepEqual(sets, [
      { set: 'mode', value: 'auto' },
      { set: 'effort', value: 'high' },
    ]);
  } finally {
    registry.get('policy')?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delegation is rejected when a harness only offers per-action approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-unsafe-'));
  const data = join(dir, 'data');
  const bin = policyAgent(
    dir,
    'ask-agent',
    `if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 'ask-1', modes: { currentModeId: 'manual', availableModes: [{ id: 'manual', name: 'Manual' }, { id: 'plan', name: 'Plan' }] } } });
else if (msg.id !== undefined) out({ id: msg.id, result: {} });`,
  );
  const registry = new HarnessRegistry(data);
  registry.register(new AcpHarnessAdapter({ id: 'ask', name: 'ask', bin, acpArgs: [] }));
  const orchestrator = new Orchestrator(registry, data, new SubagentSettings(data));
  try {
    await assert.rejects(orchestrator.delegate(null, 'ask', 'review', { cwd: dir }), /only offers per-action approval/);
  } finally {
    registry.get('ask')?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
