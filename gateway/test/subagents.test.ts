import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpHarnessAdapter } from '../src/harnesses/acp-generic.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { Orchestrator } from '../src/orchestrator.js';
import { SubagentSettings, delegationApprovalProblem, modeChoices, noteModels, recommendedDelegationMode, sessionRefs } from '../src/subagents.js';

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
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true, delete: true } } } });
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
    const harnessDefault = await orchestrator.delegate(null, 'alpha', 'own', { cwd: dir, model: null });
    await harnessDefault.done;
    assert.equal(harnessDefault.link.model, null);
    settings.setDefault('alpha', null);
    const plain = await orchestrator.delegate(null, 'alpha', 'again', { cwd: dir });
    await plain.done;
    assert.equal(plain.link.model, null);
  } finally {
    cleanup();
  }
});

test('an explicit cwd wins over the parent session folder', async () => {
  const { orchestrator, registry, cleanup, dir } = setup();
  try {
    const parent = await registry.createSession('alpha', dir);
    const other = join(dir, 'data');
    const { link, done } = await orchestrator.delegate('alpha:' + parent.sessionId, 'alpha', 'x', { cwd: other });
    await done;
    assert.equal(link.cwd, other);
    assert.equal(link.parentSessionId, 'alpha:' + parent.sessionId);
  } finally {
    cleanup();
  }
});

test('setDefault reports a failed write and keeps the old default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-sub-'));
  try {
    const settings = new SubagentSettings(join(dir, 'data'));
    settings.setDefault('alpha', 'big');
    writeFileSync(join(dir, 'data', 'subagents.json.tmp'), '');
    rmSync(join(dir, 'data', 'subagents.json.tmp'));
    mkdirSync(join(dir, 'data', 'subagents.json.tmp'));
    assert.throws(() => settings.setDefault('alpha', 'small'));
    assert.equal(settings.defaultModel('alpha'), 'big');
    assert.equal(new SubagentSettings(join(dir, 'data')).defaultModel('alpha'), 'big');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delegate rejects a model for a harness that offers no model choice', async () => {
  const { orchestrator, registry, cleanup, dir } = setup();
  try {
    await assert.rejects(orchestrator.delegate(null, 'plain', 'x', { cwd: dir, model: 'big' }), /does not offer a model choice/);
    const plain = registry.require('plain') as AcpHarnessAdapter;
    assert.equal(plain.manager.sessions.size, 0);
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

test('value-less fast mode toggles do not hide real mode choices', () => {
  const fast = { id: 'fast', name: 'Fast mode', category: 'speed', type: 'boolean', currentValue: false };
  const legacyModes = { currentModeId: 'manual', availableModes: [{ id: 'manual', name: 'Manual' }, { id: 'agent', name: 'Agent' }] };
  assert.deepEqual(modeChoices([fast], legacyModes).map((c) => c.id), ['manual', 'agent']);

  const permissions = {
    id: 'permissions',
    name: 'Permissions',
    category: 'mode',
    type: 'select',
    currentValue: 'ask',
    options: [
      { value: 'ask', name: 'Ask' },
      { value: 'auto', name: 'Auto' },
    ],
  };
  assert.equal(modeChoices([fast, permissions], legacyModes)[0]?.configId, 'permissions');
  assert.equal(recommendedDelegationMode([fast, permissions], legacyModes)?.value, 'auto');
  assert.equal(delegationApprovalProblem([fast], legacyModes), null);
});

test('select-valued fast, collaboration, and effort options are not mistaken for the permission mode', () => {
  const fastSelect = {
    id: 'fast-mode',
    name: 'Fast mode',
    category: 'speed',
    type: 'select',
    currentValue: 'off',
    options: [
      { value: 'off', name: 'Off' },
      { value: 'on', name: 'On' },
    ],
  };
  const collaboration = {
    id: 'collaboration_mode',
    name: 'Collaboration mode',
    category: 'collaboration_mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ],
  };
  const effort = {
    id: 'effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [{ value: 'medium', name: 'Medium' }],
  };
  const legacyModes = { currentModeId: 'manual', availableModes: [{ id: 'manual', name: 'Manual' }, { id: 'agent', name: 'Agent' }] };
  assert.deepEqual(modeChoices([fastSelect, collaboration, effort], legacyModes).map((c) => c.id), ['manual', 'agent']);

  const mode = {
    id: 'mode',
    name: 'Agent mode',
    category: 'mode',
    type: 'select',
    currentValue: 'agent',
    options: [
      { value: 'agent', name: 'Agent' },
      { value: 'read-only', name: 'Read only' },
    ],
  };
  assert.equal(modeChoices([fastSelect, collaboration, effort, mode], legacyModes)[0]?.configId, 'mode');
});

test('recommendedDelegationMode prefers autonomous permission handling over edit-only modes', () => {
  const codexMode = {
    id: 'mode',
    name: 'Agent mode',
    category: 'mode',
    type: 'select',
    currentValue: 'read-only',
    options: [
      { value: 'read-only', name: 'Read only', description: 'Requires approval to edit files' },
      { value: 'workspace-write', name: 'Workspace write', description: 'Edit workspace files; ask before writing outside' },
      { value: 'agent', name: 'Agent', description: 'Auto review' },
      { value: 'agent-full-access', name: 'Full access', description: 'Unrestricted' },
    ],
  };
  assert.equal(recommendedDelegationMode([codexMode], null)?.value, 'agent');

  const claudeModes = {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
      { id: 'acceptEdits', name: 'Accept edits', description: 'Automatically accept all file edits' },
      { id: 'plan', name: 'Plan' },
      { id: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
    ],
  };
  assert.equal(recommendedDelegationMode(undefined, claudeModes)?.id, 'auto');
});

test('recommendedDelegationMode ignores autonomy keywords in mode descriptions', () => {
  const mode = {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'read-only',
    options: [
      { value: 'read-only', name: 'Read only', description: 'The agent can read files but cannot edit them' },
      { value: 'agent', name: 'Agent', description: 'Asks before each edit' },
    ],
  };
  assert.equal(recommendedDelegationMode([mode], null)?.value, 'agent');
});
