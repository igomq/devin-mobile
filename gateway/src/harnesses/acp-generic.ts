import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { SessionManager, type Session, type SessionSummary } from '../sessions.js';
import type { AuthStatus, CreateSessionOptions, HarnessAdapter, HarnessCapabilities, HarnessConfig, HarnessInfo, Json } from './types.js';

const execFileAsync = promisify(execFile);

/** Variables always passed to a harness process when an env allowlist is in effect. */
export const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];

export interface AcpHarnessSpec {
  id: string;
  name: string;
  /** Executable name (resolved on PATH) or absolute path. */
  bin: string;
  /** Arguments that start the ACP server, e.g. `['acp']`. */
  acpArgs: string[];
  versionArgs?: string[];
  installHint?: string | null;
  authMethod?: string | null;
  custom?: boolean;
  cwd?: string;
  envAllowlist?: string[];
  /** False when no documented ACP entrypoint is known; the harness starts disabled until configured. */
  verified?: boolean;
  note?: string | null;
  enabled?: boolean;
}

export function resolveBin(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(bin)) return isExecutable(bin) ? bin : null;
  const dirs = [...(env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')].filter(Boolean);
  for (const d of dirs) {
    const p = join(d, bin);
    if (isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function filterEnv(allowlist: string[] | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!allowlist || allowlist.length === 0) return env;
  const out: NodeJS.ProcessEnv = {};
  for (const k of [...BASE_ENV_KEYS, ...allowlist]) {
    if (env[k] !== undefined) out[k] = env[k];
  }
  return out;
}

/**
 * Harness adapter for any agent that speaks ACP over stdio. Capabilities are taken from
 * the agent's `initialize` response instead of being assumed.
 */
export class AcpHarnessAdapter extends EventEmitter implements HarnessAdapter {
  readonly id: string;
  readonly name: string;
  readonly custom: boolean;
  readonly manager: SessionManager;

  private bin: string;
  private args: string[] = [];
  private envAllowlist: string[];
  private enabled: boolean;
  private installed = false;
  private resolvedBin: string | null = null;
  private version: string | null = null;

  constructor(private readonly spec: AcpHarnessSpec) {
    super();
    this.id = spec.id;
    this.name = spec.name;
    this.custom = !!spec.custom;
    this.bin = spec.bin;
    this.envAllowlist = [...(spec.envAllowlist ?? [])];
    this.enabled = spec.enabled ?? spec.verified !== false;
    this.manager = new SessionManager(this.bin, this.args, {
      harnessId: spec.id,
      baseArgs: spec.acpArgs,
      label: `${spec.id} acp`,
      cwd: spec.cwd,
      env: () => filterEnv(this.envAllowlist),
    });
    for (const ev of ['event', 'state', 'permission', 'permission_resolved', 'reset', 'deleted'] as const) {
      this.manager.on(ev, (...a: Json[]) => this.emit(ev, ...a));
    }
    this.manager.on('agent', () => this.emit('status', this.info()));
  }

  configure(patch: Partial<HarnessConfig>): void {
    if (patch.enabled !== undefined) this.enabled = patch.enabled;
    if (patch.bin) this.bin = patch.bin;
    if (patch.args) this.args = [...patch.args];
    if (patch.envAllowlist) this.envAllowlist = [...patch.envAllowlist];
    this.manager.updateLaunchConfig(this.bin, this.args);
  }

  async probe(): Promise<HarnessInfo> {
    this.resolvedBin = resolveBin(this.bin);
    this.installed = !!this.resolvedBin;
    this.version = null;
    this.manager.updateLaunchConfig(this.resolvedBin ?? this.bin, this.args);
    if (this.resolvedBin) {
      try {
        const { stdout } = await execFileAsync(this.resolvedBin, this.spec.versionArgs ?? ['--version'], { timeout: 5000, env: filterEnv(this.envAllowlist) });
        this.version = stdout.trim().split('\n')[0] || null;
      } catch {
        // Version probing is best effort; some ACP shims do not support --version.
      }
    }
    return this.info();
  }

  info(): HarnessInfo {
    const st = this.manager.agentStatus();
    const init = this.manager.initResult;
    const caps = init?.agentCapabilities;
    const sc = caps?.sessionCapabilities;
    const known = !!init;
    const capabilities: HarnessCapabilities = {
      acp: true,
      acpVersion: init?.protocolVersion ?? null,
      streaming: true,
      models: known ? true : false,
      reasoningLevels: false,
      modes: known,
      permissions: true,
      mcp: !!(caps?.mcpCapabilities || caps?.mcp),
      sessionResume: !!caps?.loadSession,
      sessionClose: !!sc?.close,
      sessionDelete: !!sc?.delete,
      subagents: this.manager.mcpServers().length > 0,
      usage: false,
    };
    const unverified = this.spec.verified === false;
    let error = st.error;
    if (!error && unverified && !this.installed) error = this.spec.note ?? 'No documented ACP entrypoint; configure bin/args.';
    const authStatus: AuthStatus = st.running ? 'authenticated' : 'unknown';
    return {
      id: this.id,
      name: this.name,
      version: st.agentInfo?.version ?? this.version,
      bin: this.resolvedBin ?? this.bin,
      installed: this.installed || st.running,
      enabled: this.enabled,
      custom: this.custom,
      authStatus,
      authMethod: this.spec.authMethod ?? null,
      acpSupported: !unverified || this.custom,
      acpVersion: init?.protocolVersion ?? null,
      capabilities,
      models: [],
      status: !this.installed && !st.running ? 'unavailable' : st.error && !st.running ? 'error' : st.running ? 'running' : 'idle',
      error,
      installHint: this.spec.installHint ?? null,
    };
  }

  setMcpServers(servers: () => Json[]): void {
    this.manager.mcpServers = servers;
  }

  async ensureReady(): Promise<void> {
    await this.manager.ensureAgent();
  }
  listSessions(cwd?: string): Promise<SessionSummary[]> {
    if (!this.enabled || (!this.installed && !this.manager.agentStatus().running)) return Promise.resolve([]);
    return this.manager.listSessions(cwd);
  }
  createSession(cwd: string, _opts?: CreateSessionOptions): Promise<Session> {
    return this.manager.createSession(cwd);
  }
  ensureLoaded(sessionId: string, cwd?: string): Promise<Session> {
    return this.manager.ensureLoaded(sessionId, cwd);
  }
  prompt(sessionId: string, text: string, images: { mimeType: string; data: string }[] = []): Promise<void> {
    return this.manager.prompt(sessionId, text, images);
  }
  cancel(sessionId: string): Promise<void> {
    return this.manager.cancel(sessionId);
  }
  resolvePermission(sessionId: string, requestId: string, optionId: string | null): void {
    this.manager.resolvePermission(sessionId, requestId, optionId);
  }
  setConfigOption(sessionId: string, configId: string, value: Json): Promise<SessionSummary> {
    return this.manager.setConfigOption(sessionId, configId, value);
  }
  setMode(sessionId: string, modeId: string): Promise<SessionSummary> {
    return this.manager.setMode(sessionId, modeId);
  }
  closeSession(sessionId: string): Promise<void> {
    return this.manager.closeSession(sessionId);
  }
  deleteSession(sessionId: string): Promise<void> {
    return this.manager.deleteSession(sessionId);
  }
  authenticate(methodId: string): Promise<Json> {
    return this.manager.authenticate(methodId);
  }
  stop(): void {
    this.manager.stop();
  }
}
