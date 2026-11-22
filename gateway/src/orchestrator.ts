import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { HarnessRegistry } from './harnesses/registry.js';
import { formatScopedSessionId } from './harnesses/registry.js';
import type { Session } from './sessions.js';

const execFileAsync = promisify(execFile);
type Json = any;

export type LinkKind = 'handoff' | 'delegate';
export type LinkStatus = 'running' | 'done' | 'error';

export interface SessionLink {
  id: string;
  kind: LinkKind;
  parentSessionId: string;
  childSessionId: string;
  harnessId: string;
  task: string;
  cwd: string;
  worktree: string | null;
  branch: string | null;
  status: LinkStatus;
  output: string | null;
  stopReason: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

function text(content: Json): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(text).join('');
  return content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

/** Renders a session's event log as a compact markdown transcript, keeping the newest part within `maxChars`. */
export function buildTranscript(s: Session, maxChars = 12000): string {
  const turns: { role: string; text: string }[] = [];
  const add = (role: string, t: string) => {
    if (!t) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += t;
    else turns.push({ role, text: t });
  };
  for (const { update: u } of s.events) {
    switch (u?.sessionUpdate) {
      case 'user_message_chunk':
        add('User', text(u.content));
        break;
      case 'agent_message_chunk':
        add('Assistant', text(u.content));
        break;
      case 'tool_call':
        if (u.title) add('Tool', `- ${u.title}\n`);
        break;
    }
  }
  let out = turns.map((t) => `**${t.role}:** ${t.text.trim()}`).join('\n\n');
  if (out.length > maxChars) out = '…\n' + out.slice(out.length - maxChars);
  return out;
}

/** Text of the agent's messages after the most recent user message. */
export function lastAgentReply(s: Session): string {
  let reply = '';
  for (const { update: u } of s.events) {
    if (u?.sessionUpdate === 'user_message_chunk') reply = '';
    else if (u?.sessionUpdate === 'agent_message_chunk') reply += text(u.content);
  }
  return reply.trim();
}

/** Resolves when the turn started after event `afterSeq` ends; rejects on a turn error or timeout. */
export function waitForTurn(s: Session, afterSeq: number, timeoutMs = 60 * 60 * 1000, pollMs = 100): Promise<string | null> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      for (let i = s.events.length - 1; i >= 0 && s.events[i].seq > afterSeq; i--) {
        const u = s.events[i].update;
        if (u?.sessionUpdate === '_turn_end') return resolve(u.stopReason ?? null);
        if (u?.sessionUpdate === '_turn_error') return reject(new Error(u.message ?? 'Turn failed'));
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for the subagent'));
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

export function buildHandoffPrompt(fromHarness: string, s: Session, instruction?: string): string {
  return [
    `You are continuing a coding session handed off from the ${fromHarness} harness in ${s.cwd}.`,
    'Transcript so far (newest last):',
    '',
    buildTranscript(s) || '(empty)',
    '',
    instruction?.trim() ? `Next instruction: ${instruction.trim()}` : 'Continue the work from where it stopped.',
  ].join('\n');
}

export async function createWorktree(repoCwd: string, id: string): Promise<{ path: string; branch: string }> {
  const { stdout } = await execFileAsync('git', ['-C', repoCwd, 'rev-parse', '--show-toplevel'], { timeout: 10000 });
  const top = stdout.trim();
  const branch = `uniharn/sub-${id}`;
  const path = join(top, '.uniharn', 'worktrees', id);
  await execFileAsync('git', ['-C', top, 'worktree', 'add', '-b', branch, path], { timeout: 60000 });
  return { path, branch };
}

/**
 * Cross-harness coordination: hands a session's context to another harness and runs
 * subagent tasks on any harness, optionally isolated in a git worktree.
 */
export class Orchestrator extends EventEmitter {
  private links = new Map<string, SessionLink>();
  private file: string;

  constructor(private registry: HarnessRegistry, dataDir: string) {
    super();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'orchestration.json');
    if (existsSync(this.file)) {
      try {
        for (const l of JSON.parse(readFileSync(this.file, 'utf8')).links ?? []) {
          if (l.status === 'running') Object.assign(l, { status: 'error', error: 'Gateway restarted before the task finished' });
          this.links.set(l.id, l);
        }
      } catch {
        // A corrupt file must not stop the gateway.
      }
    }
  }

  private save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ links: [...this.links.values()] }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private update(link: SessionLink, patch: Partial<SessionLink>) {
    Object.assign(link, patch, { updatedAt: Date.now() });
    this.save();
    this.emit('link', { ...link });
  }

  list(sessionId?: string): SessionLink[] {
    return [...this.links.values()]
      .filter((l) => !sessionId || l.parentSessionId === sessionId || l.childSessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): SessionLink | undefined {
    return this.links.get(id);
  }

  private async source(sessionId: string) {
    const { adapter, harnessId, nativeId } = this.registry.resolveSession(sessionId);
    const s = await adapter.ensureLoaded(nativeId);
    return { harnessId, session: s };
  }

  private async start(kind: LinkKind, parentSessionId: string, harnessId: string, cwd: string, task: string, prompt: string, worktree: { path: string; branch: string } | null) {
    const child = await this.registry.createSession(harnessId, worktree?.path ?? cwd);
    const now = Date.now();
    const link: SessionLink = {
      id: randomUUID(),
      kind,
      parentSessionId,
      childSessionId: formatScopedSessionId(harnessId, child.sessionId),
      harnessId,
      task,
      cwd: worktree?.path ?? cwd,
      worktree: worktree?.path ?? null,
      branch: worktree?.branch ?? null,
      status: 'running',
      output: null,
      stopReason: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.links.set(link.id, link);
    this.save();
    this.emit('link', { ...link });
    const before = child.seq;
    const done = this.registry
      .require(harnessId)
      .prompt(child.sessionId, prompt)
      .then(() => waitForTurn(child, before))
      .then((stopReason) => this.update(link, { status: 'done', output: lastAgentReply(child), stopReason }))
      .catch((e) => this.update(link, { status: 'error', error: String(e?.message ?? e), output: lastAgentReply(child) || null }));
    return { link, done };
  }

  /** Starts a new session on `targetHarnessId` that continues `sessionId` with its transcript as context. */
  async handoff(sessionId: string, targetHarnessId: string, instruction?: string) {
    const { harnessId, session } = await this.source(sessionId);
    const prompt = buildHandoffPrompt(harnessId, session, instruction);
    return this.start('handoff', sessionId, targetHarnessId, session.cwd, instruction ?? '', prompt, null);
  }

  /** Runs `task` as a subagent on `harnessId`, in the parent's folder or an isolated worktree. */
  async delegate(parentSessionId: string, harnessId: string, task: string, opts: { worktree?: boolean; includeContext?: boolean } = {}) {
    if (!task.trim()) throw new Error('task is required');
    const { harnessId: fromHarness, session } = await this.source(parentSessionId);
    const wt = opts.worktree ? await createWorktree(session.cwd, randomUUID().slice(0, 8)) : null;
    const prompt = opts.includeContext ? buildHandoffPrompt(fromHarness, session, task) : task;
    return this.start('delegate', parentSessionId, harnessId, session.cwd, task, prompt, wt);
  }
}
