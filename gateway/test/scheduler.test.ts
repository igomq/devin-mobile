import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { createGatewayServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Scheduler } from '../src/scheduler.js';
import { createSchedulerRpc, gatewaySchedulerOptions } from '../src/scheduler-rpc.js';
import { Session } from '../src/sessions.js';

const input = (extra = {}) => ({ title: 'Task', sessionId: 'codex:s1', steps: [{ prompt: 'Do work' }], schedule: { type: 'manual' }, ...extra });
const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)); }
};
const fixture = () => mkdtempSync(join(tmpdir(), 'scheduler-'));

test('RPC, dependency validation, failure blocking and manual release', async () => {
  const dir = fixture(); const calls: string[] = [];
  const rpc = createSchedulerRpc(dir, { checkTarget: () => {}, executor: async t => { calls.push(t.title); if (t.title === 'bad') throw Error('bad'); } });
  try {
    rpc.start();
    assert.equal(rpc.handle('other', {}), undefined);
    const a = (await rpc.handle('scheduler.create', input({ title: 'bad', schedule: { type: 'immediate' } })))!.task;
    const b = (await rpc.handle('scheduler.create', input({ title: 'dependent', dependencyIds: [a.id] })))!.task;
    await assert.rejects(rpc.handle('scheduler.update', { id: a.id, dependencyIds: [b.id] })!, /cycle/);
    await assert.rejects(rpc.handle('scheduler.create', input({ dependencyIds: ['missing'] }))!, /dependency/);
    await assert.rejects(rpc.handle('scheduler.delete', { id: a.id })!, /required/);
    await rpc.handle('scheduler.release', { id: b.id });
    await wait(() => rpc.scheduler.get(a.id).status === 'failed' && rpc.scheduler.get(b.id).condition === 'dependency_failed');
    assert.deepEqual(calls, ['bad']);
    assert.equal((await rpc.handle('scheduler.list', {}))!.tasks.length, 2);
    assert.equal((await rpc.handle('scheduler.cancel', { id: b.id }))!.task.status, 'canceled');
    await rpc.handle('scheduler.delete', { id: b.id });
    assert.equal((await rpc.handle('scheduler.delete', { id: a.id }))!.task.id, a.id);
  } finally { rpc.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('chains run after success, confirmation, bounded retry and persistence', async () => {
  const dir = fixture(); let attempts = 0; const calls: string[] = [];
  const opts = { checkTarget: () => {}, executor: async (task: any) => { calls.push(task.title); if (task.title === 'first' && ++attempts === 1) throw Error('temporary'); } };
  const s = new Scheduler(dir, opts);
  try {
    const first = await s.create(input({ title: 'first', maxAttempts: 2, retryDelayMs: 5, schedule: { type: 'delay', delayMs: 10 } }));
    const next = await s.create(input({ title: 'next', dependencyIds: [first.id], schedule: { type: 'immediate' }, steps: [{ prompt: 'initial' }, { prompt: 'check', requiresConfirmation: true }] }));
    s.start(); await wait(() => s.get(next.id).condition === 'awaiting_confirmation');
    assert.equal(s.get(first.id).status, 'done'); assert.equal(attempts, 2);
    await assert.rejects(s.update(next.id, { title: 'changed' }), /not started/);
    s.confirm(next.id); await wait(() => s.get(next.id).status === 'done');
    assert.deepEqual(calls, ['first', 'first', 'next', 'next']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'scheduler.json'), 'utf8')).length, 2);
    s.close(); const restored = new Scheduler(dir, opts); assert.equal(restored.get(next.id).status, 'done'); restored.close();
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('running cancellation and shutdown interrupt without replaying work', async () => {
  const dir = fixture(); let release!: () => void; let signal!: AbortSignal;
  const opts = { checkTarget: () => {}, executor: async (_t: any, _step: any, s: AbortSignal) => { signal = s; await new Promise<void>(r => { release = r; }); } };
  const s = new Scheduler(dir, opts);
  try {
    s.start(); const one = await s.create(input({ schedule: { type: 'immediate' } }));
    await wait(() => !!release); s.cancel(one.id); assert.equal(signal.aborted, true); assert.throws(() => s.delete(one.id), /running/);
    release(); await wait(() => { try { s.delete(one.id); return true; } catch { return false; } });
    release = undefined as any;
    const two = await s.create(input({ schedule: { type: 'immediate' } })); await wait(() => !!release);
    s.close(); assert.equal(s.get(two.id).condition, 'interrupted'); release();
    const restored = new Scheduler(dir, opts); restored.start();
    await new Promise(r => setTimeout(r, 25)); assert.equal(restored.get(two.id).condition, 'interrupted'); restored.close();
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('gateway executor waits for turn completion and cancels the scoped session', async () => {
  const adapter = new EventEmitter() as any; const session = new Session('s1', '/project', 'codex'); session.loaded = true;
  let canceled = 0; adapter.ensureLoaded = async () => session; adapter.prompt = async () => {}; adapter.cancel = async () => { canceled++; };
  const registry = { resolveSession: () => ({ adapter, nativeId: 's1', harnessId: 'codex' }) } as any;
  const workspaces = { get: () => ({ cwd: '/project', sessions: [{ sessionId: 'codex:s1', harnessId: 'codex' }] }) } as any;
  const options = gatewaySchedulerOptions(registry, workspaces, p => p, () => {});
  await options.checkTarget('codex:s1', 'w');
  const controller = new AbortController(); let done = false;
  const task = { sessionId: 'codex:s1', workspaceId: 'w' } as any;
  const running = options.executor(task, { prompt: 'work' }, controller.signal).then(() => { done = true; });
  await new Promise(r => setTimeout(r, 5)); assert.equal(done, false);
  controller.abort(); await wait(() => canceled === 1); assert.equal(done, false);
  adapter.emit('event', session, { update: { sessionUpdate: '_turn_end', stopReason: 'cancelled' } });
  await assert.rejects(running, /stopped/);
  const wrong = gatewaySchedulerOptions(registry, { get: () => undefined } as any, p => p, () => {});
  await assert.rejects(wrong.checkTarget('codex:s1', 'bad') as Promise<void>, /workspace/);
});

test('profile applies model and prelude; team waits for all roles and cancels them', async () => {
  const adapter = new EventEmitter() as any;
  const session = new Session('s', '/project', 'codex'); session.loaded = true;
  session.configOptions = [{ id: 'model', category: 'model' }];
  let prompt = ''; let model = ''; let cancellations = 0;
  adapter.ensureLoaded = async () => session;
  adapter.setConfigOption = async (_id: string, _key: string, value: string) => { model = value; };
  adapter.prompt = async (_id: string, text: string) => { prompt = text; };
  adapter.cancel = async () => { cancellations++; };
  const registry = { resolveSession: () => ({ adapter, nativeId: 's', harnessId: 'codex' }) } as any;
  const workspaces = { get: () => ({ cwd: '/project', sessions: [{ sessionId: 'codex:s', harnessId: 'codex' }] }) } as any;
  const profile = { id: 'p', cwd: '/project', harnessId: 'codex', workspaceId: 'w', model: 'model-x', prelude: 'Follow the guide' };
  const links = new Map<string, any>();
  const orchestrator = {
    get: (id: string) => links.get(id),
    delegate: async (_parent: string, _harness: string, _text: string, opts: any) => {
      assert.equal(opts.prelude, 'Follow the guide');
      const link = { id: String(links.size), status: 'running', childSessionId: 'codex:s' }; links.set(link.id, link); return { link };
    },
  };
  const presets = { profiles: { get: () => profile }, teams: { get: () => ({ id: 't', roles: [{ harnessId: 'codex' }, { harnessId: 'codex' }], profileId: 'p' }) }, orchestrator } as any;
  const options = gatewaySchedulerOptions(registry, workspaces, p => p, () => {}, presets);
  const task = { sessionId: 'codex:s', workspaceId: 'w', profile: 'p' } as any;
  const run = options.executor(task, { prompt: 'work' }, new AbortController().signal);
  await wait(() => !!prompt); assert.equal(model, 'model-x'); assert.match(prompt, /Follow the guide/);
  adapter.emit('event', session, { update: { sessionUpdate: '_turn_end', stopReason: 'end_turn' } }); await run;
  const controller = new AbortController(); let done = false;
  const teamRun = options.executor({ ...task, team: 't' }, { prompt: 'work' }, controller.signal).then(() => { done = true; });
  await wait(() => links.size === 2); controller.abort(); await wait(() => cancellations === 2); assert.equal(done, false);
  for (const link of links.values()) link.status = 'error';
  await teamRun; assert.equal(done, true);
});

test('gateway authenticates and dispatches scheduler RPCs against durable tasks', { timeout: 10000 }, async () => {
  const dir = fixture(); const bin = join(dir, 'devin');
  writeFileSync(bin, `#!/usr/bin/env node
if (process.argv[2] === 'acp') require('node:readline').createInterface({input:process.stdin}).on('line', line => { const msg=JSON.parse(line); if(msg.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1}})); });
else console.log('mock');
`, { mode: 0o755 });
  const dataDir = join(dir, 'data'); const seed = new Scheduler(dataDir, { checkTarget: () => {}, executor: async () => {} });
  const task = await seed.create(input()); seed.close();
  const config = loadConfig({ argv: ['node', 'uniharn', 'gateway', '--data-dir', dataDir, '--host', '127.0.0.1', '--devin', bin, '--port', '0'], env: { ...process.env, UNIHARN_TOKEN: 'test-token' }, detectTailscale: () => null, detectMagicDns: () => null });
  const server = createGatewayServer(config); let ws: WebSocket | undefined;
  try {
    const [{ port }] = await server.start(); ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); await once(ws, 'open');
    let next = 0;
    const request = (type: string, params: any = {}) => new Promise<any>((resolve, reject) => {
      const id = ++next; const timer = setTimeout(() => reject(Error(`RPC timeout: ${type}`)), 3000);
      const listener = (raw: any) => { const msg = JSON.parse(String(raw)); if (msg.type === 'response' && msg.id === id) { clearTimeout(timer); ws!.off('message', listener); resolve(msg); } };
      ws!.on('message', listener); ws!.send(JSON.stringify({ id, type, ...params }));
    });
    assert.equal((await request('scheduler.list')).ok, false);
    assert.equal((await request('hello', { token: 'test-token' })).ok, true);
    const listing = await request('scheduler.list'); assert.equal(listing.result.tasks[0].id, task.id);
    const canceled = await request('scheduler.cancel', { taskId: task.id }); assert.equal(canceled.result.task.status, 'canceled');
  } finally { ws?.terminate(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('absolute schedules survive restart and failed atomic writes do not change the queue', async () => {
  const dir = fixture(); let calls = 0;
  const opts = { checkTarget: () => {}, executor: async () => { calls++; } };
  try {
    const s = new Scheduler(dir, opts);
    const task = await s.create(input({ schedule: { type: 'at', at: Date.now() + 100 } }));
    assert.equal(task.status, 'scheduled'); s.close();
    const restored = new Scheduler(dir, opts); restored.start();
    assert.equal(calls, 0); await wait(() => restored.get(task.id).status === 'done'); assert.equal(calls, 1); restored.close();
    const badDir = join(dir, 'bad'); const failed = new Scheduler(badDir, opts);
    mkdirSync(join(badDir, 'scheduler.json'));
    await assert.rejects(failed.create(input()), /EISDIR|ENOTDIR|EEXIST/);
    assert.deepEqual(failed.list(), []); failed.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
