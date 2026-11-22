#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from './config.js';
import * as git from './git.js';
import { DevinHarnessAdapter } from './harnesses/devin.js';
import { createBuiltinAcpAdapters, createCustomAcpAdapter } from './harnesses/builtins.js';
import { formatScopedSessionId, HarnessRegistry } from './harnesses/registry.js';
import { listDirectory, listProjects } from './projects.js';
import type { Session } from './sessions.js';
import { serveStatic } from './static.js';
import { detectTestCommand, TaskRunner } from './tasks.js';
import { TerminalManager } from './terminal.js';
import { Orchestrator } from './orchestrator.js';
import { WorkspaceStore } from './workspaces.js';

const VERSION = '0.3.0';
const config = loadConfig();
const registry = new HarnessRegistry(config.dataDir);
const devinHarness = new DevinHarnessAdapter(config.devinBin, config.devinArgs);
registry.register(devinHarness);
for (const a of createBuiltinAcpAdapters()) registry.register(a);
registry.setCustomFactory(createCustomAcpAdapter);
void registry.probeAll();
const manager = devinHarness.manager;
const workspaces = new WorkspaceStore(config.dataDir);
const orchestrator = new Orchestrator(registry, config.dataDir);
const tasks = new TaskRunner();
const terminals = new TerminalManager(config.devinBin);

type Json = any;

interface Client {
  ws: WebSocket;
  authed: boolean;
  subs: Set<string>;
  terms: Set<string>;
  alive: boolean;
}
const clients = new Set<Client>();

function send(c: Client, msg: Json) {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}
function broadcast(msg: Json, filter: (c: Client) => boolean = () => true) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.authed && filter(c) && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
}

function tokenOk(given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

registry.on('event', (s: Session, ev) => {
  const sid = formatScopedSessionId(s.harnessId, s.sessionId);
  broadcast({ type: 'event', sessionId: sid, harnessId: s.harnessId, epoch: s.epoch, ...ev }, (c) => c.subs.has(sid));
});
registry.on('state', (summary) => {
  const sid = formatScopedSessionId(summary.harnessId, summary.sessionId);
  broadcast({ type: 'session_state', session: { ...summary, sessionId: sid } });
});
registry.on('reset', (s: Session) => {
  const sid = formatScopedSessionId(s.harnessId, s.sessionId);
  broadcast({ type: 'session_reset', sessionId: sid, harnessId: s.harnessId, epoch: s.epoch }, (c) => c.subs.has(sid));
});
registry.on('deleted', (sessionId) => {
  broadcast({ type: 'session_deleted', sessionId });
  try {
    workspaces.removeSession(sessionId);
  } catch (err) {
    console.warn(`[uniharn] failed to update workspace after session deletion (${sessionId}):`, err instanceof Error ? err.message : err);
  }
});
registry.on('harness_status', (harness) => broadcast({ type: 'harness_status', harness }));
manager.on('agent', (status) => broadcast({ type: 'agent_status', agent: status }));
registry.on('permission', (s: Session, p) => {
  const sid = formatScopedSessionId(s.harnessId, s.sessionId);
  broadcast({
    type: 'permission_request',
    sessionId: sid,
    harnessId: s.harnessId,
    title: s.title,
    requestId: p.requestId,
    toolCall: p.toolCall,
    options: p.options,
  });
});
registry.on('permission_resolved', (s: Session, requestId, optionId) => {
  const sid = formatScopedSessionId(s.harnessId, s.sessionId);
  broadcast({ type: 'permission_resolved', sessionId: sid, harnessId: s.harnessId, requestId, optionId });
});
orchestrator.on('link', (link) => broadcast({ type: 'orchestration_link', link }));
tasks.on('output', (run, chunk) => broadcast({ type: 'task_output', taskId: run.taskId, cwd: run.cwd, chunk }));
tasks.on('done', (run) => {
  const { output: _o, ...rest } = run;
  broadcast({ type: 'task_done', task: rest });
});
terminals.on('data', (termId, data) => broadcast({ type: 'term_data', termId, data }, (c) => c.terms.has(termId)));
terminals.on('exit', (info) => broadcast({ type: 'term_exit', term: info }));

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${name} is required`);
  return v;
}
function absCwd(v: unknown): string {
  const p = requireString(v, 'cwd');
  return resolve(p.startsWith('~') ? homedir() + p.slice(1) : p);
}

const ACCOUNT_FIELDS = ['Name', 'Email', 'Plan', 'Tier', 'Team membership', 'Enterprise'];
let accountCache: { at: number; value: Json } | null = null;

/** Account and plan details as reported by `devin auth status` (the CLI has no credit-balance query). */
async function accountInfo(refresh: boolean): Promise<Json> {
  if (!refresh && accountCache && Date.now() - accountCache.at < 60_000) return accountCache.value;
  const { execFile } = await import('node:child_process');
  const out = await new Promise<string>((res, rej) =>
    execFile(config.devinBin, ['auth', 'status'], { timeout: 20_000 }, (e, stdout, stderr) =>
      e && !stdout.trim() && !stderr.trim() ? rej(new Error(`Could not run devin auth status: ${e.message}`)) : res(`${stdout}\n${stderr}`),
    ),
  );
  const fields: { label: string; value: string }[] = [];
  for (const m of out.matchAll(/^[ \t]+([A-Za-z][A-Za-z ]*?):[ \t]+(.+?)[ \t]*$/gm)) {
    if (ACCOUNT_FIELDS.includes(m[1])) fields.push({ label: m[1], value: m[2] });
  }
  const value = { loggedIn: /Logged in/i.test(out) && !/Not logged in/i.test(out), fields };
  accountCache = { at: Date.now(), value };
  return value;
}

async function handle(c: Client, type: string, p: Json): Promise<Json> {
  switch (type) {
    case 'hello': {
      if (!tokenOk(p.token)) throw new Error('Invalid token');
      c.authed = true;
      manager.ensureAgent().catch(() => undefined);
      return {
        version: VERSION,
        hostname: (await import('node:os')).hostname(),
        home: homedir(),
        agent: manager.agentStatus(),
        harnesses: registry.list(),
        workspaces: workspaces.list(),
        sessions: [...manager.sessions.values()].map((s) => s.summary()),
        terminals: terminals.list(),
        tasks: tasks.list(),
      };
    }
    case 'ping':
      return { now: Date.now() };
    case 'harnesses.list':
      return { harnesses: registry.list(), custom: registry.listCustomSpecs() };
    case 'harnesses.probe': {
      if (typeof p.harnessId === 'string' && p.harnessId) {
        const adapter = registry.get(p.harnessId);
        if (!adapter) throw new Error(`Unknown harness: ${p.harnessId}`);
        return { harnesses: [await adapter.probe()] };
      }
      return { harnesses: await registry.probeAll() };
    }
    case 'harnesses.configure': {
      const harnessId = requireString(p.harnessId, 'harnessId');
      const patch: Record<string, unknown> = { ...(typeof p.config === 'object' && p.config ? p.config : {}) };
      for (const k of ['enabled', 'bin', 'args', 'defaultModel', 'envAllowlist'] as const) {
        if (p[k] !== undefined) patch[k] = p[k];
      }
      return { harness: registry.configure(harnessId, patch) };
    }
    case 'harnesses.registerCustom': {
      const src = typeof p.spec === 'object' && p.spec ? p.spec : p;
      return {
        custom: registry.saveCustomSpec({
          id: requireString(src.id, 'id'),
          name: requireString(src.name, 'name'),
          command: requireString(src.command, 'command'),
          args: src.args,
          cwd: src.cwd,
          envAllowlist: src.envAllowlist,
          enabled: src.enabled,
        }),
      };
    }
    case 'harnesses.removeCustom':
      return { removed: registry.removeCustomSpec(requireString(p.id ?? p.harnessId, 'id')) };
    case 'workspaces.list':
      return { workspaces: workspaces.list() };
    case 'workspaces.create': {
      const ws = workspaces.createOrGet(absCwd(p.cwd), { name: p.name, harnessId: p.harnessId });
      return { workspace: ws };
    }
    case 'workspaces.get': {
      const ws = workspaces.get(requireString(p.workspaceId, 'workspaceId'));
      if (!ws) throw new Error('Workspace not found');
      return { workspace: ws };
    }
    case 'agent.account':
      return accountInfo(!!p.refresh);
    case 'agent.status':
      try {
        await manager.ensureAgent();
      } catch {
        /* reported in status */
      }
      return { agent: manager.agentStatus(), capabilities: manager.initResult?.agentCapabilities ?? null };
    case 'agent.authenticate':
      return manager.authenticate(requireString(p.methodId, 'methodId'));
    case 'projects.list':
      return { projects: listProjects(config.roots, [...new Set([...manager.sessions.values()].map((s) => s.cwd))]), roots: config.roots };
    case 'fs.listDirs':
      return listDirectory(absCwd(p.path ?? homedir()));
    case 'sessions.list':
      return { sessions: await registry.listAllSessions(p.cwd ? absCwd(p.cwd) : undefined) };
    case 'session.create': {
      const cwd = absCwd(p.cwd);
      const harnessId = typeof p.harnessId === 'string' && p.harnessId ? p.harnessId : 'devin';
      const s = await registry.createSession(harnessId, cwd, { model: p.model, mode: p.mode });
      const scopedId = formatScopedSessionId(harnessId, s.sessionId);
      c.subs.add(scopedId);
      let workspaceId: string | null = null;
      try {
        const ws = p.workspaceId ? workspaces.get(p.workspaceId) : workspaces.createOrGet(cwd, { harnessId });
        if (ws) {
          workspaces.attachSession(ws.workspaceId, { harnessId, sessionId: scopedId, title: s.title, updatedAt: s.updatedAt });
          workspaceId = ws.workspaceId;
        }
      } catch (err) {
        console.warn(`[uniharn] failed to persist workspace for session ${scopedId}:`, err instanceof Error ? err.message : err);
      }
      return { session: { ...s.summary(), sessionId: scopedId, harnessId }, epoch: s.epoch, workspaceId };
    }
    case 'session.handoff': {
      const id = requireString(p.sessionId, 'sessionId');
      const target = requireString(p.harnessId, 'harnessId');
      const { link } = await orchestrator.handoff(id, target, typeof p.instruction === 'string' ? p.instruction : undefined);
      c.subs.add(link.childSessionId);
      return { link };
    }
    case 'orchestration.delegate': {
      const id = requireString(p.sessionId, 'sessionId');
      const harnessId = requireString(p.harnessId, 'harnessId');
      const task = requireString(p.task, 'task');
      const { link, done } = await orchestrator.delegate(id, harnessId, task, { worktree: !!p.worktree, includeContext: !!p.includeContext });
      if (p.wait) {
        await done;
        return { link: orchestrator.get(link.id) };
      }
      return { link };
    }
    case 'orchestration.list':
      return { links: orchestrator.list(typeof p.sessionId === 'string' ? p.sessionId : undefined) };
    case 'session.open': {
      const id = requireString(p.sessionId, 'sessionId');
      const { adapter, harnessId, nativeId } = registry.resolveSession(id);
      c.subs.add(id);
      const s = await adapter.ensureLoaded(nativeId, p.cwd ? absCwd(p.cwd) : undefined);
      const firstSeq = s.events[0]?.seq ?? s.seq + 1;
      let since = p.epoch === s.epoch && typeof p.sinceSeq === 'number' ? p.sinceSeq : 0;
      if (since > 0 && since < firstSeq - 1) since = 0;
      return {
        session: { ...s.summary(), sessionId: id, harnessId },
        epoch: s.epoch,
        full: since === 0,
        truncated: since === 0 && firstSeq > 1,
        events: s.events.filter((e) => e.seq > since),
        permissions: [...s.permissions.values()].map(({ rpcId: _r, ...rest }) => rest),
      };
    }
    case 'session.unsubscribe':
      c.subs.delete(requireString(p.sessionId, 'sessionId'));
      return {};
    case 'session.prompt': {
      const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
      await adapter.prompt(nativeId, String(p.text ?? ''), Array.isArray(p.images) ? p.images : []);
      return {};
    }
    case 'session.cancel': {
      const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
      await adapter.cancel(nativeId);
      return {};
    }
    case 'session.permission': {
      const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
      adapter.resolvePermission(nativeId, requireString(p.requestId, 'requestId'), p.optionId ?? null);
      return {};
    }
    case 'session.setConfig': {
      const id = requireString(p.sessionId, 'sessionId');
      const { adapter, harnessId, nativeId } = registry.resolveSession(id);
      const summary = await adapter.setConfigOption(nativeId, requireString(p.configId, 'configId'), p.value);
      return { session: { ...summary, sessionId: id, harnessId } };
    }
    case 'session.setMode': {
      const id = requireString(p.sessionId, 'sessionId');
      const { adapter, harnessId, nativeId } = registry.resolveSession(id);
      const summary = await adapter.setMode(nativeId, requireString(p.modeId, 'modeId'));
      return { session: { ...summary, sessionId: id, harnessId } };
    }
    case 'session.close': {
      const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
      await adapter.closeSession(nativeId);
      return {};
    }
    case 'session.delete': {
      const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
      await adapter.deleteSession(nativeId);
      return {};
    }
    case 'git.status':
      return git.status(absCwd(p.cwd));
    case 'git.diff':
      return git.diff(absCwd(p.cwd), p.path);
    case 'git.log':
      return { commits: await git.log(absCwd(p.cwd), p.limit ?? 20) };
    case 'tasks.detect':
      return { command: detectTestCommand(absCwd(p.cwd)) };
    case 'tasks.run': {
      const cwd = absCwd(p.cwd);
      const command = typeof p.command === 'string' && p.command.trim() ? p.command : detectTestCommand(cwd);
      if (!command) throw new Error('No test command detected; enter one manually');
      const { output: _o, ...rest } = tasks.start(cwd, command);
      return { task: rest };
    }
    case 'tasks.get': {
      const run = tasks.runs.get(requireString(p.taskId, 'taskId'));
      if (!run) throw new Error('Task not found');
      return { task: run };
    }
    case 'tasks.list':
      return { tasks: tasks.list(p.cwd ? absCwd(p.cwd) : undefined) };
    case 'tasks.stop':
      tasks.stop(requireString(p.taskId, 'taskId'));
      return {};
    case 'term.open': {
      const info = terminals.open({ cwd: absCwd(p.cwd ?? homedir()), cols: p.cols, rows: p.rows, kind: p.kind, args: p.args });
      c.terms.add(info.termId);
      return { term: info, scrollback: '' };
    }
    case 'term.attach': {
      const id = requireString(p.termId, 'termId');
      const r = terminals.attach(id);
      c.terms.add(id);
      return { term: r.info, scrollback: r.scrollback };
    }
    case 'term.detach':
      c.terms.delete(requireString(p.termId, 'termId'));
      return {};
    case 'term.input':
      terminals.write(requireString(p.termId, 'termId'), String(p.data ?? ''));
      return undefined;
    case 'term.resize':
      terminals.resize(requireString(p.termId, 'termId'), p.cols, p.rows);
      return undefined;
    case 'term.close':
      terminals.close(requireString(p.termId, 'termId'));
      return {};
    case 'term.list':
      return { terminals: terminals.list() };
    default:
      throw new Error(`Unknown request: ${type}`);
  }
}

const server = createServer((req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, name: 'uniharn', version: VERSION }));
      return;
    }
    if (config.staticDir) serveStatic(config.staticDir, req, res);
    else res.writeHead(404).end('uniharn gateway. Connect with the app at ws(s)://<host>/ws');
  } catch (e: any) {
    console.error(`[uniharn] http error: ${e?.message ?? e}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
wss.on('error', (e) => console.error(`[uniharn] websocket server error: ${e.message}`));
server.on('upgrade', (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket) => {
  const c: Client = { ws, authed: false, subs: new Set(), terms: new Set(), alive: true };
  clients.add(c);
  const authTimer = setTimeout(() => {
    if (!c.authed) ws.close(4001, 'auth timeout');
  }, 10000);
  ws.on('pong', () => (c.alive = true));
  ws.on('error', () => ws.terminate());
  ws.on('close', () => {
    clearTimeout(authTimer);
    clients.delete(c);
  });
  ws.on('message', async (raw) => {
    let msg: Json;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { id, type, ...params } = msg ?? {};
    if (!c.authed && type !== 'hello') {
      send(c, { type: 'response', id, ok: false, error: 'Not authenticated' });
      return;
    }
    try {
      const result = await handle(c, type, params);
      if (id !== undefined) send(c, { type: 'response', id, ok: true, result: result ?? {} });
    } catch (e: any) {
      if (id !== undefined) send(c, { type: 'response', id, ok: false, error: String(e?.message ?? e) });
      if (type === 'hello') setTimeout(() => ws.close(4003, 'invalid token'), 50);
    }
  });
});

setInterval(() => {
  for (const c of clients) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 20000).unref();

let listening = 0;
for (const host of config.hosts) {
  const srv = host === config.hosts[0] ? server : createServer(server.listeners('request')[0] as any);
  if (srv !== server) srv.on('upgrade', (...a) => server.emit('upgrade', ...a));
  srv.listen(config.port, host, () => {
    listening++;
    console.log(`[uniharn] listening on http://${host}:${config.port}  (ws path /ws)`);
    if (listening === config.hosts.length) {
      if (config.legacyMigrated) console.log(`[uniharn] migrated legacy token from ~/.local/share/devin-mobile/token`);
      console.log(`[uniharn] devin binary: ${config.devinBin}`);
      console.log(`[uniharn] static UI: ${config.staticDir ?? '(none)'}`);
      console.log(`[uniharn] token file: ${config.dataDir}/token  (pair with: uniharn gateway --print-token)`);
    }
  });
  srv.on('error', (e) => console.error(`[uniharn] failed to listen on ${host}:${config.port}: ${e.message}`));
}

if (process.argv.includes('--print-token')) console.log(`[uniharn] token: ${config.token}`);

registry.probeAll().catch(() => undefined);
manager.ensureAgent().catch((e) => console.error(`[uniharn] could not start devin acp: ${e.message}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const t of terminals.list()) terminals.close(t.termId);
    tasks.stopAll();
    process.exit(0);
  });
}
