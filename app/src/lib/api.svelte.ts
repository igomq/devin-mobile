// Connection to the uniharn gateway: one WebSocket, requests plus pushed events, with
// automatic reconnect and per-session resume from the last seen sequence number.
import { getStorageItem, removeStorageItem, setStorageItem } from './storage.ts';
import { applyUpdate, emptyState, permissionView, stateFromSummary } from './timeline.ts';
import type { AppNotification, ChangedFile, ChangedFileView, ConnInfo, HarnessInfo, Json, PendingPermission, SessionRow, SessionSummary, SessionView, TaskRun, Workspace } from './types.ts';

const STORE_SUFFIX = 'connection';

export const isTauri = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || location.hostname === 'tauri.localhost' || location.protocol === 'tauri:');

function loadSaved(): { url?: string; token?: string } {
  try {
    return JSON.parse(getStorageItem(STORE_SUFFIX) || '{}');
  } catch {
    return {};
  }
}

function initial() {
  const saved = loadSaved();
  let url = saved.url || '';
  let token = saved.token || '';
  // A pairing link ends in #token=…; take the token and drop it from the URL.
  const m = /[#&]token=([^&]+)/.exec(location.hash);
  if (m) {
    token = decodeURIComponent(m[1]);
    if (!isTauri) url = location.origin;
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!url && !isTauri && /^https?:$/.test(location.protocol) && location.port !== '5173') url = location.origin;
  return { url, token };
}

const start = typeof window === 'undefined' ? { url: '', token: '' } : initial();

export const conn = $state({
  status: 'offline' as 'offline' | 'connecting' | 'online' | 'unauthorized',
  url: start.url,
  token: start.token,
  info: null as ConnInfo | null,
  error: null as string | null,
  /** Bumped on every successful (re)connect so screens can refetch. */
  generation: 0
});

export const app = $state({
  sessions: [] as SessionRow[],
  sessionsLoaded: false,
  harnesses: [] as HarnessInfo[],
  workspaces: [] as Workspace[]
});

export const views = $state<Record<string, SessionView>>({});

type TermMessage = { ev: 'term'; data: string } | { ev: 'term-exit'; code: number | null };

let ws: WebSocket | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const termListeners = new Map<string, (msg: TermMessage) => void>();
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let wanted = false;

export function configured() {
  return Boolean(conn.url && conn.token);
}

// Transcripts belong to the gateway they came from; drop them when it changes.
function clearSessions() {
  for (const id of Object.keys(views)) delete views[id];
  app.sessions = [];
  app.sessionsLoaded = false;
}

export function saveConnection(url: string, token: string) {
  const next = url.trim().replace(/\/+$/, '');
  if (next !== conn.url) clearSessions();
  conn.url = next;
  conn.token = token.trim();
  setStorageItem(STORE_SUFFIX, JSON.stringify({ url: conn.url, token: conn.token }));
  connect(true);
}

export function forgetConnection() {
  removeStorageItem(STORE_SUFFIX);
  wanted = false;
  ws?.close();
  conn.token = '';
  conn.status = 'offline';
  conn.info = null;
  clearSessions();
}

// Accepts what people actually type: `100.x.y.z`, `host:8787`, `http(s)://…` or `ws(s)://…/ws`.
export function wsUrl(input = conn.url) {
  let u = input.trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = 'ws://' + u;
  u = u.replace(/^http(s?):\/\//i, 'ws$1://');
  const explicitPort = /^[a-z]+:\/\/(\[[^\]]*\]|[^/:?#]*):\d+/i.test(u);
  const parsed = new URL(u);
  if (!explicitPort && parsed.protocol === 'ws:') parsed.port = '8787';
  if (!/\/ws$/.test(parsed.pathname)) parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/ws';
  return parsed.toString();
}

export function connect(force = false) {
  if (!configured()) return;
  wanted = true;
  if (ws && !force && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(retryTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    dropWaiting();
  }
  conn.status = 'connecting';
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch (err) {
    conn.status = 'offline';
    conn.error = 'That server address is not valid.';
    return;
  }
  ws = sock;
  sock.onopen = async () => {
    try {
      const hello = await request('hello', { token: conn.token }, true, 10000);
      conn.info = {
        host: hello.hostname,
        home: hello.home,
        version: hello.version,
        agent: hello.agent,
        harnesses: hello.harnesses ?? [],
        workspaces: hello.workspaces ?? [],
        notifications: hello.notifications ?? null
      };
      app.sessions = (hello.sessions ?? []).map(rowKeepingActivity);
      app.harnesses = hello.harnesses ?? [];
      app.workspaces = hello.workspaces ?? [];
      conn.status = 'online';
      conn.error = null;
      conn.generation += 1;
      retry = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => conn.status === 'online' && probe(10000), 25000);
      setStorageItem(STORE_SUFFIX, JSON.stringify({ url: conn.url, token: conn.token }));
      refreshSessions();
      for (const id of Object.keys(views)) openSession(id).catch(() => {});
    } catch (err) {
      if (ws !== sock) return;
      // Only a rejected token stops the retry loop; anything else reconnects.
      if (!/token/i.test(errorText(err))) return sock.close();
      wanted = false;
      conn.status = 'unauthorized';
      conn.error = errorText(err);
    }
  };
  sock.onmessage = (e) => onMessage(JSON.parse(e.data));
  sock.onclose = () => {
    if (ws !== sock) return;
    dropWaiting();
    if (conn.status !== 'unauthorized') conn.status = wanted ? 'connecting' : 'offline';
    if (wanted) {
      retry = Math.min(retry + 1, 6);
      retryTimer = setTimeout(() => connect(true), Math.min(8000, 300 * 2 ** retry));
    }
  };
  sock.onerror = () => {
    conn.error = 'Cannot reach the server.';
  };
}

if (typeof window !== 'undefined') {
  // Phones suspend sockets in the background; reconnect as soon as the app is visible again.
  const wake = () => {
    if (!wanted || document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > WebSocket.OPEN) {
      retry = 0;
      connect(true);
    } else if (conn.status === 'online') probe(4000);
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
}

function dropWaiting() {
  for (const w of waiting.values()) {
    clearTimeout(w.timer);
    w.reject(new Error('Connection lost.'));
  }
  waiting.clear();
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function request(type: string, params: Record<string, Json> = {}, duringHello = false, timeoutMs = 120000): Promise<Json> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || (!duringHello && conn.status !== 'online')) return reject(new Error('Not connected.'));
    const id = nextId++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('The gateway did not answer in time.'));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ ...params, id, type }));
  });
}

// A socket can look open long after the network under it changed; an unanswered ping proves it is dead.
function probe(timeoutMs: number) {
  const sock = ws;
  request('ping', {}, false, timeoutMs).catch(() => {
    if (ws === sock && sock?.readyState === WebSocket.OPEN) connect(true);
  });
}

const row = (s: SessionSummary): SessionRow => ({
  id: s.sessionId,
  harnessId: s.harnessId ?? 'devin',
  cwd: s.cwd ?? null,
  title: s.title ?? null,
  updatedAt: s.updatedAt ?? null,
  status: s.status === 'unloaded' ? 'idle' : s.status,
  hasMessages: Boolean(s.title) || s.status === 'running' || s.status === 'awaiting_permission'
});

/** A session keeps counting as non-empty once it has shown activity or has a cached transcript. */
function rowKeepingActivity(s: SessionSummary): SessionRow {
  const x = row(s);
  x.hasMessages ||= Boolean(app.sessions.find((p) => p.id === x.id)?.hasMessages) || (views[x.id]?.items.length ?? 0) > 0;
  return x;
}

const sid = (p: Json) => ({ sessionId: p.id });

// The screens speak in terms of what they need; this table maps each call onto the gateway's
// request types and reshapes the answer.
const calls: Record<string, (p: Json) => Promise<Json>> = {
  'sessions.create': async (p) => {
    const r = await request('session.create', { cwd: p.cwd });
    upsert(r.session);
    return { id: r.session.sessionId, cwd: r.session.cwd };
  },
  'session.prompt': (p) => request('session.prompt', { ...sid(p), text: p.text, images: p.images ?? [] }),
  'session.cancel': (p) => request('session.cancel', sid(p)),
  'session.permission': (p) => request('session.permission', { ...sid(p), requestId: p.reqId, optionId: p.optionId }),
  'session.setMode': (p) => request('session.setMode', { ...sid(p), modeId: p.modeId }),
  'session.setConfig': (p) => request('session.setConfig', { ...sid(p), configId: p.configId, value: p.value }),
  'session.close': async (p) => {
    const r = await request('session.close', sid(p));
    delete views[p.id];
    return r;
  },
  'session.delete': async (p) => {
    const r = await request('session.delete', sid(p));
    delete views[p.id];
    return r;
  },
  'git.status': async (p) => {
    const r = await request('git.status', { cwd: p.cwd });
    return {
      repo: r.isRepo,
      branch: r.branch,
      files: r.files.map((f: ChangedFile): ChangedFileView => ({ path: f.path, kind: f.status === 'untracked' ? 'added' : f.status, added: f.binary ? null : f.additions, removed: f.binary ? null : f.deletions }))
    };
  },
  'git.diff': (p) => request('git.diff', { cwd: p.cwd, path: p.path }),
  'fs.list': async (p) => {
    const r = await request('fs.listDirs', { path: p.path });
    return { path: r.path, parent: r.parent, dirs: r.entries.map((d: { name: string; isGit: boolean }) => ({ name: d.name, git: d.isGit })) };
  },
  'tasks.detect': (p) => request('tasks.detect', { cwd: p.cwd }),
  'tasks.run': async (p) => (await request('tasks.run', { cwd: p.cwd, command: p.command })).task,
  'tasks.list': async (p) => (await request('tasks.list', { cwd: p.cwd })).tasks,
  'tasks.get': async (p) => (await request('tasks.get', { taskId: p.id })).task,
  'tasks.stop': (p) => request('tasks.stop', { taskId: p.id }),
  'term.open': async (p) => {
    const r = await request('term.open', { cwd: p.cwd, cols: p.cols, rows: p.rows, kind: p.devin ? 'devin' : 'shell', args: p.devin ?? undefined });
    return { id: r.term.termId };
  },
  'term.attach': async (p) => {
    const r = await request('term.attach', { termId: p.id });
    return { id: r.term.termId, exited: r.term.exited ? r.term.exitCode : null, buffer: r.scrollback };
  },
  'term.input': (p) => request('term.input', { termId: p.id, data: p.data }),
  'term.resize': (p) => request('term.resize', { termId: p.id, cols: p.cols, rows: p.rows }),
  'term.detach': (p) => request('term.detach', { termId: p.id }),
  'term.close': (p) => request('term.close', { termId: p.id }),
  'agent.status': async () => (await request('agent.status')).agent,
  'agent.account': (p) => request('agent.account', { refresh: !!p.refresh }),
  'harnesses.list': async () => (await request('harnesses.list')).harnesses,
  'harnesses.probe': async (p) => (await request('harnesses.probe', { harnessId: p.harnessId })).harnesses,
  'harnesses.configure': (p) => request('harnesses.configure', p),
  'workspaces.list': async () => (await request('workspaces.list')).workspaces,
  'workspaces.create': async (p) => (await request('workspaces.create', p)).workspace,
  'projects.list': () => request('projects.list'),
  'notifications.list': (p) => request('notifications.list', p),
  'notifications.read': (p) => request('notifications.read', p),
  'notifications.clear': () => request('notifications.clear'),
  'notifications.prefs.get': () => request('notifications.prefs.get'),
  'notifications.prefs.set': (p) => request('notifications.prefs.set', p),
  'notifications.capabilities': () => request('notifications.capabilities'),
  'notifications.push.publicKey': () => request('notifications.push.publicKey'),
  'notifications.push.subscribe': (p) => request('notifications.push.subscribe', p),
  'notifications.push.unsubscribe': (p) => request('notifications.push.unsubscribe', p),
  'notifications.push.list': (p) => request('notifications.push.list', p),
  'notifications.test': () => request('notifications.test')
};

export function rpc(m: string, p: Json = {}): Promise<Json> {
  const fn = calls[m];
  return fn ? fn(p) : Promise.reject(new Error(`Unknown call: ${m}`));
}

/** Pre-notification-system gateways only: a background system notification. Newer gateways send `notification` events. */
function legacyNotify(title: string, body: string) {
  if (conn.info?.notifications || document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'uniharn' });
  } catch {
    // not supported in this webview
  }
}

function upsert(summary: SessionSummary) {
  const r = row(summary);
  const i = app.sessions.findIndex((s) => s.id === r.id);
  if (i >= 0) {
    if (app.sessions[i].status === 'running' && (r.status === 'idle' || r.status === 'error')) {
      legacyNotify(r.status === 'idle' ? 'Session finished' : 'Session hit an error', r.title || r.cwd || '');
    }
    // A session keeps counting as non-empty once it has shown activity.
    r.hasMessages ||= app.sessions[i].hasMessages;
    app.sessions[i] = r;
  } else app.sessions.unshift(r);
  const v = views[r.id];
  if (v) Object.assign(v.state, stateFromSummary(summary));
}

function onMessage(msg: Json) {
  switch (msg.type) {
    case 'response': {
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      return msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error));
    }
    case 'event': {
      const v = views[msg.sessionId];
      if (!v || !v.ready) return;
      if (msg.epoch === v.epoch && msg.seq === v.seq + 1) {
        applyUpdate(v, msg.update, msg.at);
        v.seq = msg.seq;
      } else if (msg.epoch !== v.epoch || msg.seq > v.seq + 1) openSession(msg.sessionId).catch(() => {});
      return;
    }
    case 'session_reset':
      if (views[msg.sessionId]) openSession(msg.sessionId).catch(() => {});
      return;
    case 'session_state':
      return upsert(msg.session);
    case 'session_deleted':
      delete views[msg.sessionId];
      app.sessions = app.sessions.filter((s) => s.id !== msg.sessionId);
      return;
    case 'permission_request': {
      const v = views[msg.sessionId];
      const p = v && permissionView(msg, v);
      legacyNotify('Approval needed', p?.rawInput?.command ?? p?.title ?? msg.toolCall?.title ?? 'A session is waiting for your permission');
      if (v && p && !v.state.permissions.some((x) => x.reqId === msg.requestId)) v.state.permissions.push(p);
      return;
    }
    case 'permission_resolved': {
      const v = views[msg.sessionId];
      if (v) v.state.permissions = v.state.permissions.filter((x) => x.reqId !== msg.requestId);
      return;
    }
    case 'agent_status':
      if (conn.info) conn.info.agent = msg.agent;
      return;
    case 'term_data':
      return termListeners.get(msg.termId)?.({ ev: 'term', data: msg.data });
    case 'term_exit':
      return termListeners.get(msg.term.termId)?.({ ev: 'term-exit', code: msg.term.exitCode });
    case 'task_output':
    case 'task_done':
      for (const fn of taskListeners) fn(msg);
      return;
    case 'notification':
    case 'notification_read':
    case 'notifications_cleared':
      for (const fn of notificationListeners) fn(msg);
  }
}

let listInFlight: Promise<void> | null = null;
export function refreshSessions() {
  listInFlight ??= request('sessions.list')
    .then((r) => {
      app.sessions = r.sessions.map(rowKeepingActivity);
      app.sessionsLoaded = true;
    })
    .catch(() => {})
    .finally(() => (listInFlight = null));
  return listInFlight;
}

const opening = new Map<string, Promise<void>>();
/** Load or catch up a session view; concurrent calls for the same session share one request. */
export function openSession(id: string, cwd?: string | null): Promise<void> {
  let p = opening.get(id);
  if (!p) {
    p = loadSession(id, cwd).finally(() => opening.delete(id));
    opening.set(id, p);
  }
  return p;
}

async function loadSession(id: string, cwd?: string | null) {
  const v = (views[id] ??= { epoch: null, seq: 0, cwd: cwd ?? null, items: [], tools: {}, state: emptyState(), ready: false, error: null, truncated: false });
  try {
    // After a gateway restart only the session list knows this session's project; opened without it,
    // the gateway would load the session in its own working directory.
    if (!(cwd ?? v.cwd) && !app.sessions.some((s) => s.id === id)) await refreshSessions();
    const dir = cwd ?? v.cwd ?? app.sessions.find((s) => s.id === id)?.cwd;
    const r = await request('session.open', { sessionId: id, cwd: dir ?? undefined, epoch: v.ready ? v.epoch : undefined, sinceSeq: v.ready ? v.seq : undefined });
    const view = views[id];
    if (!view) return;
    if (r.full) Object.assign(view, { items: [], tools: {}, seq: 0, truncated: r.truncated });
    view.epoch = r.epoch;
    view.cwd = r.session.cwd;
    for (const e of r.events) {
      if (e.seq <= view.seq) continue;
      applyUpdate(view, e.update, e.at);
      view.seq = e.seq;
    }
    Object.assign(view.state, stateFromSummary(r.session));
    view.state.permissions = r.permissions.map((p: PendingPermission) => permissionView(p, view));
    view.ready = true;
    view.error = null;
    upsert(r.session);
  } catch (err) {
    if (views[id]) views[id].error = errorText(err);
    throw err;
  }
}

export function leaveSession(id: string) {
  delete views[id];
  request('session.unsubscribe', { sessionId: id }).catch(() => {});
}

export function onTerminal(id: string, fn: (msg: TermMessage) => void) {
  termListeners.set(id, fn);
  return () => termListeners.delete(id);
}

type TaskMessage = { type: 'task_output'; taskId: string; cwd: string; chunk: string } | { type: 'task_done'; task: TaskRun };
const taskListeners = new Set<(msg: TaskMessage) => void>();
export function onTask(fn: (msg: TaskMessage) => void) {
  taskListeners.add(fn);
  return () => taskListeners.delete(fn);
}

export type NotificationMessage =
  | { type: 'notification'; notification: AppNotification }
  | { type: 'notification_read'; ids: string[]; unreadCount: number }
  | { type: 'notifications_cleared' };
const notificationListeners = new Set<(msg: NotificationMessage) => void>();
export function onNotificationMessage(fn: (msg: NotificationMessage) => void) {
  notificationListeners.add(fn);
  return () => notificationListeners.delete(fn);
}
