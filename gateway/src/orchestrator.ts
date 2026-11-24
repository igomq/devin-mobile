import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { HarnessRegistry } from './harnesses/registry.js';
import { formatScopedSessionId } from './harnesses/registry.js';
import type { Session } from './sessions.js';
import {
  currentModeChoice,
  delegationApprovalProblem,
  effortOptionOf,
  findModeChoice,
  modelOptionOf,
  optionValueIds,
  recommendedDelegationMode,
  type SubagentSettings,
} from './subagents.js';

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
  /** Model the subagent was started with; null means the harness default. */
  model?: string | null;
  /** Git HEAD the session (or its worktree) started from; null outside a git repo. */
  baseSha?: string | null;
  /** Settings actually in effect on the child before its first prompt. */
  applied?: AppliedSettings;
  status: LinkStatus;
  output: string | null;
  stopReason: string | null;
  error: string | null;
  /** True when uniharn cancelled the child session (e.g. after a wait timeout). */
  cancelled?: boolean;
  /** Snapshot of the child's latest event and tool call, taken when the turn ended. */
  lastActivity?: Json | null;
  createdAt: number;
  updatedAt: number;
}

export interface AppliedSettings {
  model: string | null;
  mode: string | null;
  config: Record<string, string | boolean>;
}

export type LinkSummary = Pick<
  SessionLink,
  'id' | 'kind' | 'parentSessionId' | 'childSessionId' | 'harnessId' | 'model' | 'status' | 'worktree' | 'branch' | 'createdAt' | 'updatedAt'
> & { title: string };

export interface LinkFilter {
  sessionId?: string;
  status?: string;
  id?: string;
}

export const linkTitle = (task: string) => task.split('\n')[0].slice(0, 120);

/** A link without its task, output and error text, for cheap polling. */
export function summarizeLink(l: SessionLink): LinkSummary {
  return {
    id: l.id,
    kind: l.kind,
    parentSessionId: l.parentSessionId,
    childSessionId: l.childSessionId,
    harnessId: l.harnessId,
    model: l.model ?? null,
    status: l.status,
    title: linkTitle(l.task),
    worktree: l.worktree,
    branch: l.branch,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
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
      if (Date.now() - started > timeoutMs) return reject(Object.assign(new Error('Timed out waiting for the subagent'), { _timeout: true }));
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

/** HEAD commit of the repo containing `cwd`, or null when it is not a git repo. */
export async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { timeout: 10000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const offeredText = (values: string[]) => (values.length > 20 ? `${values.slice(0, 20).join(', ')}, … ${values.length - 20} more` : values.join(', '));
const duration = (ms: number) => (ms >= 60000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`);

/** A session's latest event and tool call, for link `lastActivity`. Status-only tool updates keep the title of their tool call. */
function activityOf(s: Session | undefined | null): Json | null {
  if (!s) return null;
  const last = s.events[s.events.length - 1];
  const tool = [...s.events].reverse().find((e) => e.update?.sessionUpdate === 'tool_call' || e.update?.sessionUpdate === 'tool_call_update');
  const toolTitle = tool?.update?.title ?? (tool?.update?.toolCallId ? [...s.events].reverse().find((e) => e.update?.toolCallId === tool.update.toolCallId && e.update?.title)?.update?.title : null);
  return {
    updatedAt: s.updatedAt,
    running: s.running > 0,
    lastEvent: last ? { seq: last.seq, sessionUpdate: last.update?.sessionUpdate ?? null, ...(last.update?.title ? { title: last.update.title } : {}) } : null,
    lastTool: tool ? { title: toolTitle ?? null, status: tool.update.status ?? null } : null,
  };
}

export async function createWorktree(repoCwd: string, id: string): Promise<{ path: string; branch: string; baseSha: string | null }> {
  const { stdout } = await execFileAsync('git', ['-C', repoCwd, 'rev-parse', '--show-toplevel'], { timeout: 10000 });
  const top = stdout.trim();
  const branch = `uniharn/sub-${id}`;
  const path = join(top, '.uniharn', 'worktrees', id);
  const { stdout: gitDir } = await execFileAsync('git', ['-C', top, 'rev-parse', '--git-common-dir'], { timeout: 10000 });
  const exclude = join(resolve(top, gitDir.trim()), 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('/.uniharn/')) appendFileSync(exclude, (current && !current.endsWith('\n') ? '\n' : '') + '/.uniharn/\n');
  const baseSha = await gitHead(top);
  await execFileAsync('git', ['-C', top, 'worktree', 'add', '-b', branch, path], { timeout: 60000 });
  return { path, branch, baseSha };
}

/** Removes a worktree and its branch created by {@link createWorktree}. */
export async function removeWorktree(repoCwd: string, wt: { path: string; branch: string }) {
  await execFileAsync('git', ['-C', repoCwd, 'worktree', 'remove', '--force', wt.path], { timeout: 60000 }).catch(() => undefined);
  await execFileAsync('git', ['-C', repoCwd, 'branch', '-D', wt.branch], { timeout: 10000 }).catch(() => undefined);
}

/**
 * Cross-harness coordination: hands a session's context to another harness and runs
 * subagent tasks on any harness, optionally isolated in a git worktree.
 */
export class Orchestrator extends EventEmitter {
  private links = new Map<string, SessionLink>();
  /** Child sessions started by this process, so status peeks never trigger a session/load. */
  private children = new Map<string, Session>();
  private file: string;
  /** How long a delegation waits for the child's turn before cancelling it. */
  turnTimeoutMs = 60 * 60 * 1000;

  constructor(private registry: HarnessRegistry, dataDir: string, private settings: SubagentSettings | null = null) {
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
    if (link.kind === 'delegate' && (patch.status === 'done' || patch.status === 'error')) {
      this.registry.emit('subagent_completed', {
        taskId: link.id,
        harnessId: link.harnessId,
        title: linkTitle(link.task),
        parentSessionId: link.parentSessionId,
        ok: link.status === 'done',
        summary: (link.error ?? link.output ?? '').slice(0, 500),
      });
    }
  }

  list(sessionId?: string, filter: Omit<LinkFilter, 'sessionId'> = {}): SessionLink[] {
    return [...this.links.values()]
      .filter((l) => !sessionId || l.parentSessionId === sessionId || l.childSessionId === sessionId)
      .filter((l) => (!filter.status || l.status === filter.status) && (!filter.id || l.id === filter.id))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  summaries(filter: LinkFilter = {}): LinkSummary[] {
    return this.list(filter.sessionId, filter).map(summarizeLink);
  }

  get(id: string): SessionLink | undefined {
    return this.links.get(id);
  }

  /** One link with its child's latest activity — live for running tasks, the snapshot taken at finish otherwise. */
  async detail(id: string): Promise<(SessionLink & { lastActivity: Json }) | undefined> {
    const link = this.links.get(id);
    if (!link) return undefined;
    const lastActivity = link.lastActivity ?? activityOf(this.children.get(id));
    return { ...link, lastActivity };
  }

  /**
   * Sessions that only exist as the child of a delegation with a live parent chat, in the scoped
   * form the app lists them under. Delegations without a parent session, or whose parent is gone,
   * stay in the session list so their transcripts remain reachable.
   */
  delegatedSessionIds(existingParents?: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const l of this.links.values()) {
      if (l.kind !== 'delegate' || !l.parentSessionId || !l.childSessionId) continue;
      if (existingParents && !existingParents.has(l.parentSessionId)) continue;
      out.add(l.childSessionId);
    }
    return out;
  }

  private async source(sessionId: string) {
    const { adapter, harnessId, nativeId } = this.registry.resolveSession(sessionId);
    const s = await adapter.ensureLoaded(nativeId);
    return { harnessId, session: s };
  }

  /**
   * Applies the persisted per-harness delegation policy before the first prompt and returns the config it set.
   * Config values the current model does not offer are skipped: harnesses like Devin and Vibe change their
   * effort/speed options per model, and sending a stale value fails with `Invalid params`.
   */
  private async applyDelegationPolicy(child: Session, harnessId: string): Promise<Record<string, string | boolean>> {
    const policy = this.settings?.policy(harnessId) ?? { mode: null, config: {}, enabled: true };
    if (!policy.enabled) throw new Error(`Delegation to ${harnessId} is disabled in Settings > Subagents`);
    const adapter = this.registry.require(harnessId);
    const applyMode = async (choice: Json) => {
      if (choice?.source === 'config') await adapter.setConfigOption(child.sessionId, choice.configId, String(choice.value ?? choice.id));
      else await adapter.setMode(child.sessionId, String(choice?.id ?? choice?.value));
    };
    if (policy.mode) {
      const choice = findModeChoice(child.configOptions, child.modes, policy.mode);
      if (!choice) throw new Error(`${harnessId} does not offer delegation mode ${policy.mode}`);
      await applyMode(choice);
    } else {
      const recommended = recommendedDelegationMode(child.configOptions, child.modes);
      if (recommended) await applyMode(recommended);
    }
    const problem = delegationApprovalProblem(child.configOptions, child.modes);
    if (problem) throw new Error(`Delegation to ${harnessId} is unavailable: it ${problem}`);
    const applied: Record<string, string | boolean> = {};
    for (const [configId, value] of Object.entries(policy.config)) {
      const opt = (child.configOptions ?? []).find((o: Json) => o?.id === configId || o?.configId === configId);
      if (!opt) continue;
      const boolean = typeof opt.currentValue === 'boolean' || opt.type === 'boolean';
      const v = boolean ? value === true || value === 'true' : String(value);
      const offered = optionValueIds(opt);
      if (!boolean && offered.length && !offered.includes(v as string)) continue;
      await adapter.setConfigOption(child.sessionId, opt.id ?? configId, v);
      applied[opt.id ?? configId] = v;
    }
    return applied;
  }

  /** Best-effort removal of a child session whose setup failed before its link existed. */
  private async discardChildSession(harnessId: string, sessionId: string) {
    const adapter = this.registry.require(harnessId);
    await adapter.deleteSession(sessionId).catch(() => adapter.closeSession(sessionId).catch(() => undefined));
  }

  private async start(
    kind: LinkKind,
    parentSessionId: string,
    harnessId: string,
    cwd: string,
    task: string,
    prompt: string,
    worktree: { path: string; branch: string; baseSha?: string | null } | null,
    model: string | null = null,
    effort: string | null = null,
  ) {
    const adapter = this.registry.require(harnessId);
    const child = await this.registry.createSession(harnessId, worktree?.path ?? cwd);
    let applied: AppliedSettings;
    try {
      // The model goes first: the effort and speed options a harness offers can depend on it.
      if (model) {
        const opt = modelOptionOf(child.configOptions);
        if (!opt) throw new Error(`${harnessId} does not offer a model choice`);
        const offered = optionValueIds(opt);
        if (offered.length && !offered.includes(model)) throw new Error(`${harnessId} does not offer model ${model} (offered: ${offeredText(offered)})`);
        await adapter.setConfigOption(child.sessionId, opt.id, model);
      }
      const config = kind === 'delegate' ? await this.applyDelegationPolicy(child, harnessId) : {};
      if (effort) {
        const opt = effortOptionOf(child.configOptions);
        if (!opt) throw new Error(`${harnessId} does not offer a reasoning effort choice${model ? ` for model ${model}` : ''}`);
        const offered = optionValueIds(opt);
        if (!offered.includes(effort)) throw new Error(`${harnessId} does not offer effort ${effort}${model ? ` for model ${model}` : ''} (offered: ${offeredText(offered)})`);
        await adapter.setConfigOption(child.sessionId, opt.id, effort);
        config[opt.id] = effort;
      }
      const mode = currentModeChoice(child.configOptions, child.modes);
      const current = modelOptionOf(child.configOptions)?.currentValue;
      applied = { model: typeof current === 'string' ? current : model, mode: mode ? String(mode.value ?? mode.id ?? '') || null : null, config };
    } catch (e) {
      await this.discardChildSession(harnessId, child.sessionId);
      throw e;
    }
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
      model,
      baseSha: worktree ? (worktree.baseSha ?? null) : await gitHead(cwd),
      applied,
      status: 'running',
      output: null,
      stopReason: null,
      error: null,
      cancelled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.links.set(link.id, link);
    this.children.set(link.id, child);
    this.save();
    this.emit('link', { ...link });
    const before = child.seq;
    const timeoutMs = this.turnTimeoutMs;
    const done = adapter
      .prompt(child.sessionId, prompt)
      .then(() => waitForTurn(child, before, timeoutMs))
      .then((stopReason) =>
        this.update(
          link,
          stopReason === 'cancelled'
            ? { status: 'error', stopReason, error: 'Subagent turn was cancelled before it finished', output: lastAgentReply(child) || null, lastActivity: activityOf(child) }
            : { status: 'done', output: lastAgentReply(child), stopReason, lastActivity: activityOf(child) },
        ),
      )
      .catch(async (e) => {
        const output = lastAgentReply(child) || null;
        if (!e?._timeout) return this.update(link, { status: 'error', error: `Subagent turn failed: ${String(e?.message ?? e)}`, output, lastActivity: activityOf(child) });
        const cancelError = await adapter.cancel(child.sessionId).then(
          () => null,
          (err) => String(err?.message ?? err),
        );
        // Dispatching `session/cancel` only asks the harness to stop; confirm the turn actually ended.
        const confirmed = cancelError ? false : await waitForTurn(child, before, 15_000).then(() => true, () => false);
        this.update(link, {
          status: 'error',
          stopReason: 'timeout',
          cancelled: confirmed,
          error: `Timed out after ${duration(timeoutMs)}; ${cancelError ? `cancelling the subagent session failed: ${cancelError}` : confirmed ? 'subagent session was cancelled' : 'a cancel was sent but the subagent session did not stop'}`,
          output,
          lastActivity: activityOf(child),
        });
      })
      .finally(() => this.children.delete(link.id));
    return { link, done };
  }

  /** Starts a new session on `targetHarnessId` that continues `sessionId` with its transcript as context. */
  async handoff(sessionId: string, targetHarnessId: string, instruction?: string) {
    const { harnessId, session } = await this.source(sessionId);
    const prompt = buildHandoffPrompt(harnessId, session, instruction);
    return this.start('handoff', sessionId, targetHarnessId, session.cwd, instruction ?? '', prompt, null);
  }

  /**
   * Runs `task` as a subagent on `harnessId`, in `opts.cwd` (else the parent's folder)
   * or in an isolated worktree of it. `model: null` runs on the harness default model;
   * omitting it uses the default subagent model.
   */
  async delegate(
    parentSessionId: string | null,
    harnessId: string,
    task: string,
    opts: { cwd?: string; worktree?: boolean; includeContext?: boolean; model?: string | null; effort?: string | null } = {},
  ) {
    if (!task.trim()) throw new Error('task is required');
    if (this.settings && !this.settings.policy(harnessId).enabled) {
      throw new Error(`Delegation to ${harnessId} is disabled in Settings > Subagents`);
    }
    const parent = parentSessionId ? await this.source(parentSessionId) : null;
    const cwd = opts.cwd ?? parent?.session.cwd;
    if (!cwd) throw new Error('sessionId or cwd is required');
    const wt = opts.worktree ? await createWorktree(cwd, randomUUID().slice(0, 8)) : null;
    const prompt = parent && opts.includeContext ? buildHandoffPrompt(parent.harnessId, parent.session, task) : task;
    try {
      const model = opts.model === undefined ? (this.settings?.defaultModel(harnessId) ?? null) : opts.model || null;
      return await this.start('delegate', parentSessionId ?? '', harnessId, cwd, task, prompt, wt, model, opts.effort || null);
    } catch (e) {
      if (wt) await removeWorktree(cwd, wt);
      throw e;
    }
  }
}
