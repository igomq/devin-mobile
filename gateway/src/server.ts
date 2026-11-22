import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, hostname } from 'node:os';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { AuthStore, MIN_APP_VERSION, PROTOCOL_VERSION } from './auth.js';
import type { Config } from './config.js';
import { collectDiagnostics, gatewaySecurity, suggestedUrls, VERSION } from './diagnostics.js';
import * as git from './git.js';
import { createBuiltinAcpAdapters, createCustomAcpAdapter } from './harnesses/builtins.js';
import { DevinHarnessAdapter } from './harnesses/devin.js';
import { formatScopedSessionId, HarnessRegistry } from './harnesses/registry.js';
import { checkRateLimit, clientIp, exchangePairingCode, handlePairRequest, RequestError, sendJson } from './pairing.js';
import { NotificationService } from './notifications.js';
import { Orchestrator } from './orchestrator.js';
import { listDirectory, listProjects } from './projects.js';
import { assertAllowedPath, isPathWithinRoots, RateLimiter, redactSecrets } from './security.js';
import type { Session } from './sessions.js';
import { serveStatic } from './static.js';
import { detectTestCommand, TaskRunner } from './tasks.js';
import { TerminalManager } from './terminal.js';
import { WorkspaceStore } from './workspaces.js';

type Json = any;

interface Client {
  ws: WebSocket;
  ip: string;
  authed: boolean;
  deviceId: string | null;
  subs: Set<string>;
  terms: Set<string>;
  alive: boolean;
}

export function createGatewayRegistry(config: Config) {
  const registry = new HarnessRegistry(config.dataDir);
  const devinHarness = new DevinHarnessAdapter(config.devinBin, config.devinArgs);
  registry.register(devinHarness);
  for (const adapter of createBuiltinAcpAdapters()) registry.register(adapter);
  registry.setCustomFactory(createCustomAcpAdapter);
  return { registry, manager: devinHarness.manager };
}

export function createGatewayServer(input: Config) {
  const config = { ...input };
  const authStore = new AuthStore(config.dataDir, config.token);
  const { registry, manager } = createGatewayRegistry(config);
  const workspaces = new WorkspaceStore(config.dataDir);
  const orchestrator = new Orchestrator(registry, config.dataDir);
  const mcpEntry = join(dirname(fileURLToPath(import.meta.url)), 'mcp.js');
  if (process.env.UNIHARN_SUBAGENT_MCP !== '0' && existsSync(mcpEntry)) {
    // Every harness session gets uniharn's MCP server so its agent can delegate to other harnesses.
    // The token goes in a 0600 file, not the MCP env, so harnesses never see it in ACP request payloads.
    const mcpTokenFile = join(config.dataDir, 'mcp-token');
    writeFileSync(mcpTokenFile, config.token + '\n', { mode: 0o600 });
    chmodSync(mcpTokenFile, 0o600);
    registry.setMcpServers((cwd) => {
      const bind = config.hosts[0] ?? '127.0.0.1';
      const host = bind === '*' || bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind;
      const env = [
        { name: 'UNIHARN_DATA_DIR', value: config.dataDir },
        { name: 'UNIHARN_TOKEN_FILE', value: mcpTokenFile },
        { name: 'UNIHARN_GATEWAY_URL', value: `ws://${host.includes(':') ? `[${host}]` : host}:${config.port}/ws` },
      ];
      return [{ name: 'uniharn', command: process.execPath, args: [mcpEntry], env: cwd ? [...env, { name: 'UNIHARN_SESSION_CWD', value: cwd }] : env }];
    });
  }
  const tasks = new TaskRunner();
  const terminals = new TerminalManager(config.devinBin);
  const notifications = new NotificationService(config.dataDir);
  const clients = new Set<Client>();
  const pairLimiter = new RateLimiter();
  const helloLimiter = new RateLimiter();
  const gatewayInfo = {
    gatewayId: authStore.gatewayId,
    hostname: hostname(),
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    minAppVersion: MIN_APP_VERSION,
  };
  const security = gatewaySecurity(config);
  const safeMessage = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error), [config.token]);

  function send(c: Client, msg: Json) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }
  function broadcast(msg: Json, filter: (c: Client) => boolean = () => true) {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.authed && filter(c) && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }

  registry.on('event', (s: Session, ev) => {
    const sid = formatScopedSessionId(s.harnessId, s.sessionId);
    broadcast({ type: 'event', sessionId: sid, harnessId: s.harnessId, epoch: s.epoch, ...ev }, (c) => c.subs.has(sid));
    notifications.onSessionActivity(sid, s.harnessId, s.title);
  });
  registry.on('state', (summary) => {
    const sid = formatScopedSessionId(summary.harnessId, summary.sessionId);
    broadcast({ type: 'session_state', session: { ...summary, sessionId: sid } });
    notifications.onSessionState({ ...summary, sessionId: sid });
  });
  registry.on('reset', (s: Session) => {
    const sid = formatScopedSessionId(s.harnessId, s.sessionId);
    broadcast({ type: 'session_reset', sessionId: sid, harnessId: s.harnessId, epoch: s.epoch }, (c) => c.subs.has(sid));
  });
  registry.on('deleted', (sessionId) => {
    broadcast({ type: 'session_deleted', sessionId });
    notifications.onSessionForgotten(sessionId);
    try {
      workspaces.removeSession(sessionId);
    } catch (err) {
      console.warn(safeMessage(`[uniharn] failed to update workspace after session deletion (${sessionId}): ${err}`));
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
    notifications.onPermissionRequested({
      sessionId: sid,
      harnessId: s.harnessId,
      title: s.title,
      requestId: p.requestId,
      toolTitle: p.toolCall?.title ?? null,
      command: typeof p.toolCall?.rawInput?.command === 'string' ? p.toolCall.rawInput.command : null,
    });
  });
  registry.on('permission_resolved', (s: Session, requestId, optionId) => {
    const sid = formatScopedSessionId(s.harnessId, s.sessionId);
    broadcast({ type: 'permission_resolved', sessionId: sid, harnessId: s.harnessId, requestId, optionId });
    notifications.onPermissionResolved(sid, requestId);
  });
  orchestrator.on('link', (link) => broadcast({ type: 'orchestration_link', link }));
  // Emitted by the orchestrator when a delegated subagent task ends.
  registry.on('subagent_completed', (t: Json) => notifications.notifySubagentCompleted(t ?? {}));
  notifications.on('notification', (n) => broadcast({ type: 'notification', notification: n }));
  notifications.on('read', (ids: string[], unreadCount: number) => broadcast({ type: 'notification_read', ids, unreadCount }));
  notifications.on('cleared', () => broadcast({ type: 'notifications_cleared' }));
  tasks.on('output', (run, chunk) => broadcast({ type: 'task_output', taskId: run.taskId, cwd: run.cwd, chunk }));
  tasks.on('done', (run) => {
    const { output: _o, ...rest } = run;
    broadcast({ type: 'task_done', task: rest });
    notifications.onTaskDone(run);
  });
  terminals.on('data', (termId, data) => broadcast({ type: 'term_data', termId, data }, (c) => c.terms.has(termId)));
  terminals.on('exit', (info) => broadcast({ type: 'term_exit', term: info }));

  function requireString(v: unknown, name: string): string {
    if (typeof v !== 'string' || !v) throw new Error(`${name} is required`);
    return v;
  }
  function absCwd(v: unknown): string {
    const p = requireString(v, 'cwd');
    return assertAllowedPath(resolve(p.startsWith('~') ? homedir() + p.slice(1) : p), config.roots, config.strictRoots);
  }

  const checkGitRoot = config.strictRoots ? (root: string) => assertAllowedPath(root, config.roots, true) : undefined;

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
        checkRateLimit(helloLimiter, c.ip);
        const auth = authStore.authenticate(typeof p.token === 'string' ? p.token : '', config.token, c.ip);
        if (!auth.ok) {
          helloLimiter.recordFailure(c.ip);
          throw new RequestError(401, auth.error);
        }
        helloLimiter.reset(c.ip);
        c.deviceId = auth.deviceId;
        c.authed = true;
        manager.ensureAgent().catch(() => undefined);
        return {
          ...gatewayInfo,
          deviceId: auth.deviceId,
          authKind: auth.authKind,
          deviceName: auth.deviceName,
          security,
          home: homedir(),
          agent: manager.agentStatus(),
          harnesses: registry.list(),
          workspaces: workspaces.list(),
          sessions: [...manager.sessions.values()].map((s) => s.summary()),
          terminals: terminals.list(),
          tasks: tasks.list(),
          notifications: { unreadCount: notifications.unreadCount(), lastSeq: notifications.lastSeq() },
        };
      }
      case 'pair': {
        const { device, token } = exchangePairingCode(authStore, pairLimiter, c.ip, p);
        c.authed = true;
        c.deviceId = device.deviceId;
        manager.ensureAgent().catch(() => undefined);
        return { deviceId: device.deviceId, token, device, ...gatewayInfo };
      }
      case 'pairing.create': {
        if (p.ttlSec !== undefined && (typeof p.ttlSec !== 'number' || !Number.isFinite(p.ttlSec))) {
          throw new Error('ttlSec must be a number');
        }
        const url = p.url === undefined ? config.publicUrl ?? suggestedUrls(config)[0] : requireString(p.url, 'url');
        const { codeId, code, pairingUri, qrSvg, expiresAt } = await authStore.createPairingCode({ ttlSec: p.ttlSec, url });
        return { codeId, code, pairingUri, qrSvg, expiresAt };
      }
      case 'pairing.list':
        return { codes: authStore.listPairingCodes() };
      case 'pairing.revoke':
        return { revoked: authStore.revokePairingCode(requireString(p.codeId, 'codeId')) };
      case 'devices.list':
        return { devices: authStore.listDevices(c.deviceId) };
      case 'devices.rename':
        return { device: authStore.renameDevice(requireString(p.deviceId, 'deviceId'), requireString(p.name, 'name')) };
      case 'devices.revoke': {
        const device = authStore.revokeDevice(requireString(p.deviceId, 'deviceId'));
        notifications.removeDeviceSubscriptions(device.deviceId);
        const targets = [...clients].filter((client) => client.authed && client.deviceId === device.deviceId);
        // Let the RPC reply reach the caller before closing it on self-revocation.
        for (const target of targets) {
          if (target === c) setImmediate(() => disconnectRevoked(target));
          else disconnectRevoked(target);
        }
        return { device, disconnected: targets.length };
      }
      case 'devices.rotate':
        if (!c.deviceId) throw new Error('Master token cannot be rotated here');
        return authStore.rotateDeviceToken(c.deviceId);
      case 'gateway.diagnostics':
        return collectDiagnostics(config, registry, authStore, new Set(
          [...clients].filter((client) => client.authed && client.deviceId).map((client) => client.deviceId),
        ).size);
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
      case 'projects.list': {
        const paths = [...new Set([...manager.sessions.values()].map((s) => s.cwd))];
        const projects = listProjects(config.roots, paths)
          .filter((project) => !config.strictRoots || isPathWithinRoots(project.path, config.roots));
        return { projects, roots: config.roots };
      }
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
          console.warn(safeMessage(`[uniharn] failed to persist workspace for session ${scopedId}: ${err}`));
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
        const id = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null;
        const harnessId = requireString(p.harnessId, 'harnessId');
        const task = requireString(p.task, 'task');
        const { link, done } = await orchestrator.delegate(id, harnessId, task, {
          cwd: id ? undefined : absCwd(p.cwd),
          worktree: !!p.worktree,
          includeContext: !!p.includeContext,
        });
        c.subs.add(link.childSessionId);
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
      case 'git.status': {
        const cwd = absCwd(p.cwd);
        const st = await git.status(cwd, checkGitRoot);
        if (st.isRepo) notifications.notifyGitConflict(cwd, st.files.filter((f) => f.status === 'conflict').map((f) => f.path));
        return st;
      }
      case 'notifications.list':
        return notifications.list({ sinceSeq: typeof p.sinceSeq === 'number' ? p.sinceSeq : undefined, limit: typeof p.limit === 'number' ? p.limit : undefined, unreadOnly: !!p.unreadOnly });
      case 'notifications.read':
        return { ids: notifications.markRead(Array.isArray(p.ids) ? p.ids.map(String) : null), unreadCount: notifications.unreadCount() };
      case 'notifications.clear':
        notifications.clear();
        return {};
      case 'notifications.prefs.get':
        return { prefs: notifications.getPrefs() };
      case 'notifications.prefs.set':
        return { prefs: notifications.setPrefs(typeof p.prefs === 'object' && p.prefs ? p.prefs : {}) };
      case 'notifications.capabilities':
        return { capabilities: notifications.getCapabilities() };
      case 'notifications.push.publicKey':
        return { publicKey: notifications.publicKey() };
      case 'notifications.push.subscribe':
        return notifications.subscribe(p.subscription, typeof p.label === 'string' ? p.label : null, c.deviceId);
      case 'notifications.push.unsubscribe':
        return notifications.unsubscribe(requireString(p.endpoint, 'endpoint'));
      case 'notifications.push.list':
        return { subscriptions: notifications.listSubscriptions(), subscribed: typeof p.endpoint === 'string' ? notifications.hasSubscription(p.endpoint) : undefined };
      case 'notifications.test': {
        const n = notifications.notify({ type: 'task_completed', title: 'Test notification', body: 'Notifications from this gateway are working.', safeBody: 'Notifications from this gateway are working.', route: '#/settings', dedupKey: `test:${Date.now()}` });
        if (!n) return { delivered: false, reason: 'Notifications or the task-completed event are turned off' };
        const push = await notifications.waitForPush(n.id);
        return { delivered: true, notification: n, push };
      }
      case 'git.diff':
        return git.diff(absCwd(p.cwd), p.path, checkGitRoot);
      case 'git.log':
        return { commits: await git.log(absCwd(p.cwd), p.limit ?? 20, checkGitRoot) };
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

  function disconnectRevoked(client: Client) {
    if (!client.authed || !client.deviceId) return;
    notifications.removeDeviceSubscriptions(client.deviceId);
    client.authed = false;
    send(client, { type: 'device_revoked', deviceId: client.deviceId, reason: 'Device token has been revoked' });
    client.ws.close(4003, 'device revoked');
  }

  function checkDevice(client: Client): boolean {
    if (!client.deviceId) return true;
    const device = authStore.listDevices().find((row) => row.deviceId === client.deviceId);
    if (device?.revokedAt === null) return true;
    disconnectRevoked(client);
    return false;
  }

  async function request(req: IncomingMessage, res: ServerResponse) {
    try {
      const { pathname } = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true, name: 'uniharn', ...gatewayInfo, tailscaleIp: config.tailscaleIp, magicDns: config.magicDns });
      } else if (pathname === '/api/pair') {
        await handlePairRequest(req, res, authStore, pairLimiter, gatewayInfo);
      } else if (config.staticDir) {
        serveStatic(config.staticDir, req, res);
      } else {
        res.writeHead(404).end('uniharn gateway. Connect with the app at ws(s)://<host>/ws');
      }
    } catch (error) {
      console.error(`[uniharn] HTTP error: ${safeMessage(error)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal server error' });
      else res.end();
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  wss.on('error', (error) => console.error(`[uniharn] WebSocket server error: ${safeMessage(error)}`));
  const servers: Server[] = config.hosts.map(() => {
    const server = createServer(request);
    server.on('upgrade', (req, socket, head) => {
      if (req.url?.split('?', 1)[0] !== '/ws') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    return server;
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const c: Client = { ws, ip: clientIp(req), authed: false, deviceId: null, subs: new Set(), terms: new Set(), alive: true };
    clients.add(c);
    const authTimer = setTimeout(() => {
      if (!c.authed) ws.close(4001, 'auth timeout');
    }, 10_000);
    ws.on('pong', () => (c.alive = true));
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(c);
    });
    ws.on('message', async (raw) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let msg: Json;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { id, type, ...params } = msg ?? {};
      if (!c.authed && type !== 'hello' && type !== 'pair') {
        send(c, { type: 'response', id, ok: false, error: 'Not authenticated' });
        return;
      }
      try {
        if (!checkDevice(c)) return;
        const result = await handle(c, type, params);
        if (c.authed) clearTimeout(authTimer);
        if (id !== undefined) send(c, { type: 'response', id, ok: true, result: result ?? {} });
      } catch (error) {
        const expected = error instanceof RequestError;
        if (id !== undefined) send(c, {
          type: 'response', id, ok: false, error: expected ? error.message : safeMessage(error),
          ...(expected && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        });
        if (type === 'hello') {
          c.authed = false;
          ws.close(4003, expected && error.message === 'Device token has been revoked' ? 'device revoked' : 'invalid token');
        }
      }
    });
  });

  let heartbeat: NodeJS.Timeout | undefined;
  let revocationPoll: NodeJS.Timeout | undefined;
  let starting = false;
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      clearInterval(heartbeat);
      clearInterval(revocationPoll);
      for (const client of clients) client.ws.terminate();
      for (const term of terminals.list()) terminals.close(term.termId);
      tasks.stopAll();
      notifications.dispose();
      manager.stop();
      await Promise.all([
        new Promise<void>((done) => wss.close(() => done())),
        ...servers.map((server) => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        })),
      ]);
    })();
    return closing;
  }

  async function start(): Promise<AddressInfo[]> {
    if (starting || closing) throw new Error('Gateway has already been started or closed');
    if (!servers.length) throw new Error('Gateway requires at least one bind host');
    starting = true;
    const addresses: AddressInfo[] = [];
    try {
      for (const [i, server] of servers.entries()) {
        const host = config.hosts[i] === '*' ? '0.0.0.0' : config.hosts[i];
        await new Promise<void>((done, reject) => {
          server.once('error', reject);
          server.listen(config.port, host, () => {
            server.off('error', reject);
            done();
          });
        });
        const address = server.address() as AddressInfo;
        config.port = address.port;
        addresses.push(address);
        server.on('error', (error) => console.error(`[uniharn] HTTP server error: ${safeMessage(error)}`));
      }
    } catch (error) {
      await close();
      throw error;
    }
    if (security.isRoot) console.warn('[uniharn] Gateway is running as root. Run it as a non-root user.');
    if (security.publicBindWarning) console.warn('[uniharn] Gateway is listening on all interfaces. Bind to loopback or your Tailscale address.');
    heartbeat = setInterval(() => {
      for (const client of clients) {
        if (!client.alive) client.ws.terminate();
        else if (client.ws.readyState === WebSocket.OPEN) {
          client.alive = false;
          client.ws.ping();
        }
      }
    }, 20_000).unref();
    let lastPollError: string | undefined;
    let revocationTick = 0;
    revocationPoll = setInterval(() => {
      // Every 250 ms while device clients are connected, otherwise every 5 s (push subscriptions only).
      if (![...clients].some((client) => client.authed && client.deviceId) && revocationTick++ % 20 !== 0) return;
      try {
        const devices = authStore.listDevices();
        // Revocations can come from the CLI while the device is offline: drop its push subscriptions too.
        for (const device of devices) if (device.revokedAt !== null) notifications.removeDeviceSubscriptions(device.deviceId);
        const active = new Set(devices.filter((device) => device.revokedAt === null).map((device) => device.deviceId));
        for (const client of clients) {
          if (client.deviceId && !active.has(client.deviceId)) disconnectRevoked(client);
        }
        lastPollError = undefined;
      } catch (error) {
        const message = safeMessage(error);
        if (message !== lastPollError) console.error(`[uniharn] Could not check device revocations: ${message}`);
        lastPollError = message;
      }
    }, 250).unref();
    registry.probeAll().catch(() => undefined);
    manager.ensureAgent().catch((error) => {
      if (!closing) console.error(`[uniharn] could not start devin acp: ${safeMessage(error)}`);
    });
    return addresses;
  }

  /** Tells connected apps and Web Push subscribers the gateway is going away, then waits briefly for delivery. */
  async function notifyShutdown(reason: string): Promise<void> {
    const n = notifications.notifyGatewayShutdown(reason);
    const push = n ? notifications.waitForPush(n.id) : Promise.resolve();
    await Promise.race([push, new Promise((done) => setTimeout(done, 1500))]);
  }

  return { start, close, notifyShutdown };
}
