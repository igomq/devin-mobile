import { EventEmitter } from 'node:events';
import { AcpConnection } from './acp.js';

type Json = any;

export type SessionStatus = 'idle' | 'running' | 'awaiting_permission' | 'error' | 'unloaded';

export interface SessionEvent {
  seq: number;
  at: number;
  update: Json;
}

export interface PendingPermission {
  requestId: string;
  rpcId: Json;
  toolCall: Json;
  options: Json[];
  at: number;
}

export interface SessionSummary {
  sessionId: string;
  harnessId: string;
  cwd: string;
  title: string | null;
  status: SessionStatus;
  loaded: boolean;
  updatedAt: number;
  lastStopReason: string | null;
  lastError: string | null;
  pendingPermissions: number;
  configOptions: Json[];
  modes: Json | null;
  commands: Json[];
  usage: Json | null;
  tokens: TokenTotals;
  turnStats: Json[] | null;
}

export interface TokenTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
}

const MAX_EVENTS = 20000;

export class Session {
  events: SessionEvent[] = [];
  seq = 0;
  /** Bumped whenever history is rebuilt (e.g. after an agent restart); clients must resync fully. */
  epoch = Date.now();
  loaded = false;
  running = 0;
  title: string | null = null;
  updatedAt = Date.now();
  lastStopReason: string | null = null;
  lastError: string | null = null;
  configOptions: Json[] = [];
  /** The agent's own config options; `configOptions` adds `modelOption` when these have no model. */
  agentConfigOptions: Json[] = [];
  /** Model picker built from the agent's `models` field; changes go through `session/set_model`. */
  modelOption: Json | null = null;
  modes: Json | null = null;
  commands: Json[] = [];
  usage: Json | null = null;
  /** Summed from each `session/prompt` result's `usage` while this gateway runs. */
  tokens: TokenTotals = { turns: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 };
  /** Session-wide totals from Devin CLI's `_cognition.ai/turn_stats` (label/value rows). */
  turnStats: Json[] | null = null;
  permissions = new Map<string, PendingPermission>();

  constructor(public sessionId: string, public cwd: string, public harnessId = 'devin') {}

  get status(): SessionStatus {
    if (this.permissions.size > 0) return 'awaiting_permission';
    if (this.running > 0) return 'running';
    if (!this.loaded) return 'unloaded';
    if (this.lastError) return 'error';
    return 'idle';
  }

  get modelsFromSetModel(): boolean {
    return !!this.modelOption && !this.agentConfigOptions.some((o) => o?.category === 'model');
  }

  setConfigOptions(opts?: Json[]) {
    if (opts) this.agentConfigOptions = opts;
    this.configOptions = this.modelsFromSetModel ? [...this.agentConfigOptions, this.modelOption] : this.agentConfigOptions;
  }

  summary(): SessionSummary {
    return {
      sessionId: this.sessionId,
      harnessId: this.harnessId,
      cwd: this.cwd,
      title: this.title,
      status: this.status,
      loaded: this.loaded,
      updatedAt: this.updatedAt,
      lastStopReason: this.lastStopReason,
      lastError: this.lastError,
      pendingPermissions: this.permissions.size,
      configOptions: this.configOptions,
      modes: this.modes,
      commands: this.commands,
      usage: this.usage,
      tokens: this.tokens,
      turnStats: this.turnStats,
    };
  }

  push(update: Json): SessionEvent {
    const ev = { seq: ++this.seq, at: Date.now(), update };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.updatedAt = ev.at;
    return ev;
  }

  reset() {
    this.events = [];
    this.seq = 0;
    this.epoch = Date.now();
  }
}

/**
 * Owns a single long-lived `devin acp` process and every session it hosts. Work keeps running
 * here regardless of whether any mobile client is connected.
 *
 * Emits: 'event' (session, SessionEvent), 'state' (SessionSummary), 'permission' (session, PendingPermission),
 *        'permission_resolved' (session, requestId), 'reset' (session), 'agent' (status object)
 */
export interface SessionManagerLaunchOptions {
  harnessId?: string;
  /** Arguments placed before the configured extra args. Defaults to `['acp']` (Devin CLI). */
  baseArgs?: string[];
  label?: string;
  cwd?: string;
  env?: () => NodeJS.ProcessEnv;
}

export class SessionManager extends EventEmitter {
  private acp: AcpConnection | null = null;
  private starting: Promise<AcpConnection> | null = null;
  private loading = new Map<string, Promise<Session>>();
  sessions = new Map<string, Session>();
  private permCounter = 0;
  agentError: string | null = null;

  constructor(
    private bin: string,
    private extraArgs: string[] = [],
    private readonly launch: SessionManagerLaunchOptions = {},
  ) {
    super();
  }

  /** MCP servers offered to every new or loaded session (ACP `mcpServers`). */
  mcpServers: (cwd?: string) => Json[] = () => [];

  updateLaunchConfig(bin: string, extraArgs: string[]): void {
    this.bin = bin;
    this.extraArgs = [...extraArgs];
  }

  get initResult() {
    return this.acp?.initResult ?? null;
  }

  agentStatus() {
    return {
      running: !!this.acp?.alive,
      error: this.agentError,
      agentInfo: this.acp?.initResult?.agentInfo ?? null,
      authMethods: this.acp?.initResult?.authMethods ?? [],
    };
  }

  async ensureAgent(): Promise<AcpConnection> {
    if (this.acp?.alive) return this.acp;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const label = this.launch.label ?? 'devin acp';
      const conn = new AcpConnection(this.bin, [...(this.launch.baseArgs ?? ['acp']), ...this.extraArgs], this.launch.env?.() ?? process.env, {
        label,
        ...(this.launch.cwd ? { cwd: this.launch.cwd } : {}),
      });
      conn.on('notification', (m, p) => this.onNotification(m, p));
      conn.on('request', (id, m, p) => this.onRequest(conn, id, m, p));
      conn.on('exit', (code) => {
        if (this.acp === conn) this.acp = null;
        this.agentError = `${label} exited (${code}). ${conn.stderrTail.slice(-3).join(' | ')}`;
        for (const s of this.sessions.values()) {
          s.loaded = false;
          s.running = 0;
          for (const p of s.permissions.values()) this.emit('permission_resolved', s, p.requestId, null);
          s.permissions.clear();
          this.emit('state', s.summary());
        }
        this.emit('agent', this.agentStatus());
      });
      try {
        await conn.start();
        this.acp = conn;
        this.agentError = null;
        this.emit('agent', this.agentStatus());
        return conn;
      } catch (e: any) {
        this.agentError = String(e?.message ?? e);
        conn.stop();
        throw e;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private getOrCreate(sessionId: string, cwd: string): Session {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new Session(sessionId, cwd, this.launch.harnessId ?? 'devin');
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private applySessionResult(s: Session, r: Json) {
    if (!r) return;
    if (r.modes) s.modes = r.modes;
    if (Array.isArray(r.models?.availableModels)) s.modelOption = modelsToConfigOption(r.models);
    s.setConfigOptions(Array.isArray(r.configOptions) ? r.configOptions : undefined);
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    const out = new Map<string, SessionSummary>();
    try {
      const acp = await this.ensureAgent();
      if (acp.initResult?.agentCapabilities?.sessionCapabilities?.list) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < 200; page++) {
          const r = await acp.request('session/list', { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) }, 15000);
          for (const info of r?.sessions ?? []) {
            const s = this.getOrCreate(info.sessionId, info.cwd);
            if (info.title && !s.title) s.title = info.title;
            if (info.updatedAt) {
              const t = Date.parse(info.updatedAt);
              if (!Number.isNaN(t) && !s.loaded) s.updatedAt = t;
            }
          }
          cursor = r?.nextCursor;
          if (!cursor || seen.has(cursor)) break;
          seen.add(cursor);
        }
      }
    } catch (e: any) {
      this.agentError = String(e?.message ?? e);
    }
    for (const s of this.sessions.values()) {
      if (cwd && s.cwd !== cwd) continue;
      out.set(s.sessionId, s.summary());
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSession(cwd: string): Promise<Session> {
    const acp = await this.ensureAgent();
    const r = await acp.request('session/new', { cwd, mcpServers: this.mcpServers(cwd) }, 60000);
    const s = this.getOrCreate(r.sessionId, cwd);
    s.loaded = true;
    this.applySessionResult(s, r);
    this.emit('state', s.summary());
    return s;
  }

  /** Make sure the agent has this session in memory (session/load replays history as updates). */
  async ensureLoaded(sessionId: string, cwd?: string): Promise<Session> {
    // One load per session: a second session/load would replay the whole history into the log again.
    const pending = this.loading.get(sessionId);
    if (pending) return pending;
    const known = this.sessions.get(sessionId);
    const s = this.getOrCreate(sessionId, cwd ?? known?.cwd ?? process.cwd());
    if (s.loaded && this.acp?.alive) return s;
    const load = this.load(s).finally(() => this.loading.delete(sessionId));
    this.loading.set(sessionId, load);
    return load;
  }

  private async load(s: Session): Promise<Session> {
    const acp = await this.ensureAgent();
    s.reset();
    this.emit('reset', s);
    s.loaded = true; // updates during replay must be accepted
    try {
      const r = await acp.request('session/load', { sessionId: s.sessionId, cwd: s.cwd, mcpServers: this.mcpServers(s.cwd) }, 120000);
      this.applySessionResult(s, r);
    } catch (e) {
      s.loaded = false;
      throw e;
    }
    this.emit('state', s.summary());
    return s;
  }

  async prompt(sessionId: string, text: string, images: { mimeType: string; data: string }[] = []) {
    const s = await this.ensureLoaded(sessionId);
    const acp = await this.ensureAgent();
    const content: Json[] = [];
    if (text) content.push({ type: 'text', text });
    for (const img of images) content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
    const ev = s.push({ sessionUpdate: 'user_message_chunk', content: content[0] ?? { type: 'text', text: '' }, _local: true, _content: content });
    this.emit('event', s, ev);
    s.running++;
    s.lastError = null;
    this.emit('state', s.summary());
    acp
      .request('session/prompt', { sessionId, prompt: content })
      .then((r) => {
        s.lastStopReason = r?.stopReason ?? null;
        const u = r?.usage;
        if (u) {
          s.tokens = {
            turns: s.tokens.turns + 1,
            inputTokens: s.tokens.inputTokens + (u.inputTokens ?? 0),
            outputTokens: s.tokens.outputTokens + (u.outputTokens ?? 0),
            cachedReadTokens: s.tokens.cachedReadTokens + (u.cachedReadTokens ?? 0),
          };
        }
        const done = s.push({ sessionUpdate: '_turn_end', stopReason: s.lastStopReason });
        this.emit('event', s, done);
      })
      .catch((e: any) => {
        s.lastError = String(e?.message ?? e);
        const err = s.push({ sessionUpdate: '_turn_error', message: s.lastError });
        this.emit('event', s, err);
      })
      .finally(() => {
        s.running = Math.max(0, s.running - 1);
        if (s.running === 0) this.cancelPermissions(s);
        this.emit('state', s.summary());
      });
  }

  async cancel(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const acp = await this.ensureAgent();
    acp.notify('session/cancel', { sessionId });
    this.cancelPermissions(s);
    this.emit('state', s.summary());
  }

  private cancelPermissions(s: Session) {
    for (const p of s.permissions.values()) {
      this.acp?.respond(p.rpcId, { outcome: { outcome: 'cancelled' } });
      this.emit('permission_resolved', s, p.requestId, null);
    }
    s.permissions.clear();
  }

  resolvePermission(sessionId: string, requestId: string, optionId: string | null) {
    const s = this.sessions.get(sessionId);
    const p = s?.permissions.get(requestId);
    if (!s || !p) throw new Error('Permission request is no longer pending');
    s.permissions.delete(requestId);
    this.acp?.respond(p.rpcId, optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    const ev = s.push({ sessionUpdate: '_permission_resolved', requestId, optionId, toolCallId: p.toolCall?.toolCallId });
    this.emit('event', s, ev);
    this.emit('permission_resolved', s, requestId, optionId);
    this.emit('state', s.summary());
  }

  async setConfigOption(sessionId: string, configId: string, value: Json) {
    const s = await this.ensureLoaded(sessionId);
    const acp = await this.ensureAgent();
    if (configId === 'model' && s.modelsFromSetModel) {
      await acp.request('session/set_model', { sessionId, modelId: value }, 30000);
      s.modelOption = { ...s.modelOption, currentValue: value };
      s.setConfigOptions();
      this.emit('state', s.summary());
      return s.summary();
    }
    const params: Json = { sessionId, configId, value };
    if (typeof value === 'boolean') params.type = 'boolean';
    const r = await acp.request('session/set_config_option', params, 30000);
    this.applySessionResult(s, r);
    this.emit('state', s.summary());
    return s.summary();
  }

  async setMode(sessionId: string, modeId: string) {
    const s = await this.ensureLoaded(sessionId);
    const acp = await this.ensureAgent();
    await acp.request('session/set_mode', { sessionId, modeId }, 30000);
    if (s.modes) s.modes = { ...s.modes, currentModeId: modeId };
    this.emit('state', s.summary());
    return s.summary();
  }

  async closeSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    const acp = await this.ensureAgent();
    if (s?.running) await this.cancel(sessionId);
    if (acp.initResult?.agentCapabilities?.sessionCapabilities?.close) {
      await acp.request('session/close', { sessionId }, 30000).catch(() => undefined);
    }
    if (s) {
      s.loaded = false;
      this.emit('state', s.summary());
    }
  }

  async deleteSession(sessionId: string) {
    const acp = await this.ensureAgent();
    await this.closeSession(sessionId).catch(() => undefined);
    if (!acp.initResult?.agentCapabilities?.sessionCapabilities?.delete) {
      throw new Error('This Devin CLI version cannot delete sessions; the session was ended instead.');
    }
    await acp.request('session/delete', { sessionId }, 30000);
    this.sessions.delete(sessionId);
    this.emit('deleted', sessionId);
  }

  async authenticate(methodId: string) {
    const acp = await this.ensureAgent();
    return acp.request('authenticate', { methodId }, 300000);
  }

  stop() {
    this.acp?.stop();
    this.acp = null;
  }

  private onTurnStats(params: Json) {
    const s = this.sessions.get(params?.sessionId);
    if (!s || !Array.isArray(params.responseDimensions)) return;
    s.turnStats = params.responseDimensions
      .filter((d: Json) => d?.kind && (d.kind.type === 'metric' || d.kind.type === 'cumulativeMetric'))
      .map((d: Json) => ({ id: d.uid, group: d.groupTitle ?? null, label: d.label, value: d.kind.value }));
    this.emit('state', s.summary());
  }

  private onNotification(method: string, params: Json) {
    if (method === '_cognition.ai/turn_stats') return this.onTurnStats(params);
    if (method !== 'session/update' || !params?.sessionId) return;
    const s = this.sessions.get(params.sessionId);
    if (!s) return;
    const u = params.update ?? {};
    switch (u.sessionUpdate) {
      case 'config_option_update':
        if (Array.isArray(u.configOptions)) s.setConfigOptions(u.configOptions);
        this.emit('state', s.summary());
        break;
      case 'current_mode_update':
        if (s.modes) s.modes = { ...s.modes, currentModeId: u.currentModeId };
        this.emit('state', s.summary());
        break;
      case 'available_commands_update':
        s.commands = u.availableCommands ?? [];
        this.emit('state', s.summary());
        return;
      case 'session_info_update':
        if (u.title !== undefined) s.title = u.title;
        this.emit('state', s.summary());
        break;
      case 'usage_update':
        s.usage = u;
        this.emit('state', s.summary());
        return;
    }
    const ev = s.push(u);
    this.emit('event', s, ev);
  }

  private onRequest(conn: AcpConnection, id: Json, method: string, params: Json) {
    if (method === '_cognition.ai/turn_stats') {
      this.onTurnStats(params);
      conn.respond(id, {});
      return;
    }
    if (method === 'session/request_permission') {
      const s = this.sessions.get(params?.sessionId);
      if (!s) {
        conn.respond(id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      const requestId = `perm_${++this.permCounter}`;
      const p: PendingPermission = { requestId, rpcId: id, toolCall: params.toolCall, options: params.options ?? [], at: Date.now() };
      s.permissions.set(requestId, p);
      const ev = s.push({ sessionUpdate: '_permission_request', requestId, toolCall: p.toolCall, options: p.options });
      this.emit('event', s, ev);
      this.emit('permission', s, p);
      this.emit('state', s.summary());
      return;
    }
    conn.respondError(id, -32601, `Method not supported by uniharn gateway: ${method}`);
  }
}

/** Turns an ACP `models` result (`availableModels`, `currentModelId`) into a select config option. */
export function modelsToConfigOption(models: Json): Json {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: models.currentModelId ?? models.availableModels[0]?.modelId ?? null,
    options: models.availableModels.map((m: Json) => ({ value: m.modelId, name: m.name ?? m.modelId, ...(m.description ? { description: m.description } : {}) })),
  };
}
