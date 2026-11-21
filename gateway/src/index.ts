#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from './config.js';
import * as git from './git.js';
import { listDirectory, listProjects } from './projects.js';
import { SessionManager, type Session } from './sessions.js';
import { serveStatic } from './static.js';
import { detectTestCommand, TaskRunner } from './tasks.js';
import { TerminalManager } from './terminal.js';

const VERSION = '0.1.0';
const config = loadConfig();
const manager = new SessionManager(config.devinBin, config.devinArgs);
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

manager.on('event', (s: Session, ev) => broadcast({ type: 'event', sessionId: s.sessionId, epoch: s.epoch, ...ev }, (c) => c.subs.has(s.sessionId)));
manager.on('state', (summary) => broadcast({ type: 'session_state', session: summary }));
manager.on('reset', (s: Session) => broadcast({ type: 'session_reset', sessionId: s.sessionId, epoch: s.epoch }, (c) => c.subs.has(s.sessionId)));
manager.on('deleted', (sessionId) => broadcast({ type: 'session_deleted', sessionId }));
manager.on('agent', (status) => broadcast({ type: 'agent_status', agent: status }));
manager.on('permission', (s: Session, p) =>
  broadcast({ type: 'permission_request', sessionId: s.sessionId, title: s.title, requestId: p.requestId, toolCall: p.toolCall, options: p.options }),
);
manager.on('permission_resolved', (s: Session, requestId, optionId) => broadcast({ type: 'permission_resolved', sessionId: s.sessionId, requestId, optionId }));
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
        sessions: [...manager.sessions.values()].map((s) => s.summary()),
        terminals: terminals.list(),
        tasks: tasks.list(),
      };
    }
    case 'ping':
      return { now: Date.now() };
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
      return { sessions: await manager.listSessions(p.cwd ? absCwd(p.cwd) : undefined) };
    case 'session.create': {
      const s = await manager.createSession(absCwd(p.cwd));
      c.subs.add(s.sessionId);
      return { session: s.summary(), epoch: s.epoch };
    }
    case 'session.open': {
      const id = requireString(p.sessionId, 'sessionId');
      c.subs.add(id);
      const s = await manager.ensureLoaded(id, p.cwd ? absCwd(p.cwd) : undefined);
      const since = p.epoch === s.epoch && typeof p.sinceSeq === 'number' ? p.sinceSeq : 0;
      return {
        session: s.summary(),
        epoch: s.epoch,
        full: since === 0,
        events: s.events.filter((e) => e.seq > since),
        permissions: [...s.permissions.values()].map(({ rpcId: _r, ...rest }) => rest),
      };
    }
    case 'session.unsubscribe':
      c.subs.delete(requireString(p.sessionId, 'sessionId'));
      return {};
    case 'session.prompt':
      await manager.prompt(requireString(p.sessionId, 'sessionId'), String(p.text ?? ''), Array.isArray(p.images) ? p.images : []);
      return {};
    case 'session.cancel':
      await manager.cancel(requireString(p.sessionId, 'sessionId'));
      return {};
    case 'session.permission':
      manager.resolvePermission(requireString(p.sessionId, 'sessionId'), requireString(p.requestId, 'requestId'), p.optionId ?? null);
      return {};
    case 'session.setConfig':
      return { session: await manager.setConfigOption(requireString(p.sessionId, 'sessionId'), requireString(p.configId, 'configId'), p.value) };
    case 'session.setMode':
      return { session: await manager.setMode(requireString(p.sessionId, 'sessionId'), requireString(p.modeId, 'modeId')) };
    case 'session.close':
      await manager.closeSession(requireString(p.sessionId, 'sessionId'));
      return {};
    case 'session.delete':
      await manager.deleteSession(requireString(p.sessionId, 'sessionId'));
      return {};
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
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }
    if (config.staticDir) serveStatic(config.staticDir, req, res);
    else res.writeHead(404).end('Devin Mobile gateway. Connect with the app at ws(s)://<host>/ws');
  } catch (e: any) {
    console.error(`[devin-mobile] http error: ${e?.message ?? e}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
wss.on('error', (e) => console.error(`[devin-mobile] websocket server error: ${e.message}`));
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
    console.log(`[devin-mobile] listening on http://${host}:${config.port}  (ws path /ws)`);
    if (listening === config.hosts.length) {
      console.log(`[devin-mobile] devin binary: ${config.devinBin}`);
      console.log(`[devin-mobile] static UI: ${config.staticDir ?? '(none)'}`);
      console.log(`[devin-mobile] token file: ${config.dataDir}/token  (pair with: devin-mobile-gateway --print-token)`);
    }
  });
  srv.on('error', (e) => console.error(`[devin-mobile] failed to listen on ${host}:${config.port}: ${e.message}`));
}

if (process.argv.includes('--print-token')) console.log(`[devin-mobile] token: ${config.token}`);

manager.ensureAgent().catch((e) => console.error(`[devin-mobile] could not start devin acp: ${e.message}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const t of terminals.list()) terminals.close(t.termId);
    tasks.stopAll();
    process.exit(0);
  });
}
