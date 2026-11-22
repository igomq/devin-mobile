import type { EventEmitter } from 'node:events';
import type { Session, SessionSummary } from '../sessions.js';

export type Json = any;

export type BuiltinHarnessId = 'devin' | 'codex' | 'claude' | 'kiro' | 'opencode' | 'command-code' | 'antigravity';
export type HarnessId = BuiltinHarnessId | string;

export type AuthStatus = 'authenticated' | 'unauthenticated' | 'unknown';
export type HarnessRunStatus = 'idle' | 'running' | 'error' | 'unavailable';

export interface HarnessCapabilities {
  acp: boolean;
  acpVersion: number | null;
  streaming: boolean;
  models: boolean;
  reasoningLevels: boolean;
  modes: boolean;
  permissions: boolean;
  mcp: boolean;
  sessionResume: boolean;
  sessionClose: boolean;
  sessionDelete: boolean;
  subagents: boolean;
  usage: boolean;
}

export interface HarnessModel {
  id: string;
  name: string;
  provider?: string;
  reasoningLevels?: string[];
  modes?: string[];
  speeds?: string[];
  default?: boolean;
}

export interface HarnessConfig {
  id: HarnessId;
  enabled: boolean;
  bin?: string;
  args?: string[];
  envAllowlist?: string[];
  cwd?: string;
  custom?: boolean;
  name?: string;
}

export interface CustomAcpHarnessSpec {
  id: string;
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  envAllowlist?: string[];
  enabled?: boolean;
}

export interface HarnessInfo {
  id: HarnessId;
  name: string;
  version: string | null;
  bin: string;
  installed: boolean;
  enabled: boolean;
  custom: boolean;
  authStatus: AuthStatus;
  authMethod: string | null;
  acpSupported: boolean;
  acpVersion: number | null;
  capabilities: HarnessCapabilities;
  models: HarnessModel[];
  status: HarnessRunStatus;
  error: string | null;
  installHint: string | null;
}

export interface CreateSessionOptions {
  model?: string;
  mode?: string;
  mcpServers?: Json[];
}

export interface HarnessAdapter extends EventEmitter {
  readonly id: HarnessId;
  readonly name: string;
  readonly custom: boolean;

  probe(): Promise<HarnessInfo>;
  info(): HarnessInfo;
  configure(patch: Partial<HarnessConfig>): void;
  ensureReady(): Promise<void>;
  listSessions(cwd?: string): Promise<SessionSummary[]>;
  createSession(cwd: string, opts?: CreateSessionOptions): Promise<Session>;
  ensureLoaded(sessionId: string, cwd?: string): Promise<Session>;
  prompt(sessionId: string, text: string, images?: { mimeType: string; data: string }[]): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  resolvePermission(sessionId: string, requestId: string, optionId: string | null): void;
  setConfigOption(sessionId: string, configId: string, value: Json): Promise<SessionSummary>;
  setMode(sessionId: string, modeId: string): Promise<SessionSummary>;
  closeSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  authenticate?(methodId: string): Promise<Json>;
  stop(): void;
}
