import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpHarnessAdapter } from '../src/harnesses/acp-generic.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { Orchestrator, buildTranscript, lastAgentReply } from '../src/orchestrator.js';

function echoAgent(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('${name} 1.0.0'); process.exit(0); }
let n = 0;
const cwds = {};
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (msg.method === 'session/new') { const id = '${name}-' + (++n); cwds[id] = msg.params.cwd; out({ id: msg.id, result: { sessionId: id } }); }
  else if (msg.method === 'session/prompt') {
    const text = msg.params.prompt[0].text;
    const reply = text.includes('Transcript so far') ? 'context:' + (text.includes('fix the parser') ? 'yes' : 'no') : '${name} did ' + text;
    setTimeout(() => {
      out({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } } });
      out({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' cwd=' + cwds[msg.params.sessionId] } } } });
      out({ id: msg.id, result: { stopReason: 'end_turn' } });
    }, 20);
  } else if (msg.id !== undefined) out({ id: msg.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  return p;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-orch-'));
  const registry = new HarnessRegistry(join(dir, 'data'));
  for (const id of ['alpha', 'beta']) {
    registry.register(new AcpHarnessAdapter({ id, name: id, bin: echoAgent(dir, id), acpArgs: [] }));
  }
  const orchestrator = new Orchestrator(registry, join(dir, 'data'));
  const cleanup = () => {
    for (const h of registry.list()) registry.get(h.id)?.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, registry, orchestrator, cleanup };
}

async function waitIdle(registry: HarnessRegistry, harnessId: string, nativeId: string) {
  const s = await registry.require(harnessId).ensureLoaded(nativeId);
  for (let i = 0; i < 100 && !s.events.some((e) => e.update.sessionUpdate === '_turn_end'); i++) await new Promise((r) => setTimeout(r, 20));
  return s;
}

test('handoff carries the source transcript to a session on another harness', async () => {
  const { dir, registry, orchestrator, cleanup } = setup();
  try {
    const src = await registry.createSession('alpha', dir);
    await registry.require('alpha').prompt(src.sessionId, 'fix the parser');
    await waitIdle(registry, 'alpha', src.sessionId);
    assert.match(buildTranscript(src), /\*\*User:\*\* fix the parser/);
    assert.match(lastAgentReply(src), /^alpha did fix the parser/);

    const { link, done } = await orchestrator.handoff(`alpha:${src.sessionId}`, 'beta', 'add tests');
    assert.equal(link.kind, 'handoff');
    assert.equal(link.childSessionId, 'beta:beta-1');
    await done;
    const finished = orchestrator.get(link.id)!;
    assert.equal(finished.status, 'done');
    assert.match(finished.output ?? '', /^context:yes/);
    assert.equal(orchestrator.list(`alpha:${src.sessionId}`).length, 1);
  } finally {
    cleanup();
  }
});

test('delegate runs a subagent in an isolated git worktree and persists the link', async () => {
  const { dir, registry, orchestrator, cleanup } = setup();
  try {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const parent = await registry.createSession('alpha', repo);
    const events: string[] = [];
    orchestrator.on('link', (l) => events.push(l.status));
    const completed: any[] = [];
    registry.on('subagent_completed', (e) => completed.push(e));

    const { link, done } = await orchestrator.delegate(`alpha:${parent.sessionId}`, 'beta', 'write docs', { worktree: true });
    assert.ok(link.worktree && existsSync(link.worktree));
    assert.match(link.branch ?? '', /^uniharn\/sub-/);
    await done;
    const finished = orchestrator.get(link.id)!;
    assert.equal(finished.status, 'done');
    assert.equal(finished.stopReason, 'end_turn');
    assert.match(finished.output ?? '', /^beta did write docs cwd=.*\.uniharn\/worktrees\//);
    assert.deepEqual(events, ['running', 'done']);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].taskId, link.id);
    assert.equal(completed[0].harnessId, 'beta');
    assert.equal(completed[0].title, 'write docs');
    assert.equal(completed[0].parentSessionId, `alpha:${parent.sessionId}`);
    assert.equal(completed[0].ok, true);
    assert.match(completed[0].summary, /^beta did write docs/);
    assert.match(execFileSync('git', ['-C', repo, 'worktree', 'list']).toString(), /uniharn\/sub-/);
    assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString(), '');

    const saved = JSON.parse(readFileSync(join(dir, 'data', 'orchestration.json'), 'utf8'));
    assert.equal(saved.links[0].id, link.id);
    const reloaded = new Orchestrator(registry, join(dir, 'data'));
    assert.equal(reloaded.get(link.id)?.status, 'done');
    await assert.rejects(orchestrator.delegate(`alpha:${parent.sessionId}`, 'beta', '  '), /task is required/);
    await assert.rejects(orchestrator.delegate(null, 'beta', 'x'), /sessionId or cwd is required/);
    const { link: free, done: freeDone } = await orchestrator.delegate(null, 'alpha', 'lint', { cwd: repo });
    await freeDone;
    assert.equal(orchestrator.get(free.id)?.parentSessionId, '');
    assert.match(orchestrator.get(free.id)?.output ?? '', /^alpha did lint cwd=.*repo$/);
    const worktrees = () => execFileSync('git', ['-C', repo, 'worktree', 'list']).toString();
    const branches = () => execFileSync('git', ['-C', repo, 'branch']).toString();
    const [wtBefore, brBefore] = [worktrees(), branches()];
    await assert.rejects(orchestrator.delegate(null, 'nope', 'x', { cwd: repo, worktree: true }));
    assert.equal(worktrees(), wtBefore);
    assert.equal(branches(), brBefore);
  } finally {
    cleanup();
  }
});

test('delegatedSessionIds lists only delegate children in their scoped form', async () => {
  const { dir, registry, orchestrator, cleanup } = setup();
  try {
    const parent = await registry.createSession('alpha', dir);
    assert.equal(orchestrator.delegatedSessionIds().size, 0);

    const { link, done } = await orchestrator.delegate(`alpha:${parent.sessionId}`, 'beta', 'research');
    await done;
    assert.equal(link.childSessionId, 'beta:beta-1');
    assert.deepEqual([...orchestrator.delegatedSessionIds()], [link.childSessionId]);
    assert.ok(!orchestrator.delegatedSessionIds().has(`alpha:${parent.sessionId}`));

    // A delegation without a parent session stays in the session list too.
    const free = await orchestrator.delegate(null, 'beta', 'solo', { cwd: dir });
    await free.done;
    assert.equal(orchestrator.delegatedSessionIds().size, 1);

    // Handoffs are full sessions and stay in the session list.
    const handoff = await orchestrator.handoff(`alpha:${parent.sessionId}`, 'beta', 'continue');
    await handoff.done;
    assert.equal(orchestrator.delegatedSessionIds().size, 1);
  } finally {
    cleanup();
  }
});

test('registry offers its MCP servers to every adapter and marks subagent support', async () => {
  const { registry, cleanup } = setup();
  try {
    const server = { name: 'uniharn', command: 'node', args: ['mcp.js'], env: [] };
    registry.setMcpServers((cwd) => [{ ...server, env: cwd ? [{ name: 'UNIHARN_SESSION_CWD', value: cwd }] : [] }]);
    const alpha = registry.require('alpha') as AcpHarnessAdapter;
    assert.deepEqual(alpha.manager.mcpServers(), [server]);
    assert.deepEqual(alpha.manager.mcpServers('/w'), [{ ...server, env: [{ name: 'UNIHARN_SESSION_CWD', value: '/w' }] }]);
    assert.equal(alpha.info().capabilities.subagents, true);
    const late = new AcpHarnessAdapter({ id: 'gamma', name: 'gamma', bin: 'missing-gamma', acpArgs: [] });
    registry.register(late);
    assert.deepEqual(late.manager.mcpServers(), [server]);
  } finally {
    cleanup();
  }
});
