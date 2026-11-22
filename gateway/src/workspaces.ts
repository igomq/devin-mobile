import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { HarnessId } from './harnesses/types.js';

export interface WorkspaceSessionRef {
  harnessId: HarnessId;
  sessionId: string;
  title: string | null;
  updatedAt: number;
}

export interface Workspace {
  workspaceId: string;
  cwd: string;
  name: string;
  activeHarnessId: HarnessId;
  activeSessionId: string | null;
  sessions: WorkspaceSessionRef[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Separates Workspace (project directory + user workflow) from underlying Harness Sessions.
 * One Workspace can host multiple sessions across different harnesses and persists across restarts.
 */
export class WorkspaceStore {
  private workspaces = new Map<string, Workspace>();
  private filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filePath = join(dataDir, 'workspaces.json');
    this.load();
  }

  private load() {
    if (!existsSync(this.filePath)) return;
    try {
      const list = JSON.parse(readFileSync(this.filePath, 'utf8')) as Workspace[];
      if (!Array.isArray(list)) return;
      for (const w of list) {
        if (w?.workspaceId && w?.cwd) this.workspaces.set(w.workspaceId, w);
      }
    } catch {
      // Ignore corrupt file rather than crashing gateway boot.
    }
  }

  private save() {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.workspaces.values()], null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  list(): Workspace[] {
    return [...this.workspaces.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(workspaceId: string): Workspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  findByCwd(cwd: string): Workspace | undefined {
    const norm = resolve(cwd);
    for (const w of this.workspaces.values()) {
      if (resolve(w.cwd) === norm) return w;
    }
    return undefined;
  }

  createOrGet(cwd: string, opts: { name?: string; harnessId?: HarnessId } = {}): Workspace {
    const norm = resolve(cwd);
    const existing = this.findByCwd(norm);
    if (existing) return existing;
    const now = Date.now();
    const w: Workspace = {
      workspaceId: `ws_${randomUUID().slice(0, 12)}`,
      cwd: norm,
      name: opts.name?.trim() || basename(norm) || norm,
      activeHarnessId: opts.harnessId ?? 'devin',
      activeSessionId: null,
      sessions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.set(w.workspaceId, w);
    this.save();
    return w;
  }

  attachSession(workspaceId: string, ref: WorkspaceSessionRef, makeActive = true): Workspace {
    const w = this.workspaces.get(workspaceId);
    if (!w) throw new Error(`Workspace not found: ${workspaceId}`);
    const idx = w.sessions.findIndex((s) => s.sessionId === ref.sessionId);
    if (idx >= 0) w.sessions[idx] = { ...w.sessions[idx], ...ref };
    else w.sessions.unshift(ref);
    if (makeActive) {
      w.activeHarnessId = ref.harnessId;
      w.activeSessionId = ref.sessionId;
    }
    w.updatedAt = Date.now();
    this.save();
    return w;
  }

  removeSession(sessionId: string): void {
    let changed = false;
    for (const w of this.workspaces.values()) {
      const before = w.sessions.length;
      w.sessions = w.sessions.filter((s) => s.sessionId !== sessionId);
      if (w.sessions.length !== before) {
        if (w.activeSessionId === sessionId) w.activeSessionId = w.sessions[0]?.sessionId ?? null;
        w.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
