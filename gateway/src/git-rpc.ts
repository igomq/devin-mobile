import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as git from './git.js';
import * as github from './github.js';

type Json = any;

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${name} is required`);
  return v;
}
function absCwd(v: unknown): string {
  const p = requireString(v, 'cwd');
  return resolve(p.startsWith('~') ? homedir() + p.slice(1) : p);
}
const worktreePath = (p: Json) => requireString(p.worktreePath ?? p.path, 'worktreePath');

/**
 * Git, worktree and GitHub PR requests (`git.*`). Returns `undefined` for request types it does not own,
 * so the gateway's request handler can delegate with a single call.
 */
export interface GitRpcOptions {
  /** Called with every successful `git.status` result, keyed by the requested cwd. */
  onStatus?: (cwd: string, status: git.GitStatus) => void;
}

export function createGitRpc(dataDir: string, opts: GitRpcOptions = {}) {
  const sessionPrs = new github.SessionPrStore(dataDir);
  const handlers: Record<string, (p: Json) => Promise<Json> | Json> = {
    'git.status': async (p) => {
      const cwd = absCwd(p.cwd);
      const st = await git.status(cwd);
      if (st.isRepo) opts.onStatus?.(cwd, st);
      return st;
    },
    'git.diff': (p) => git.diff(absCwd(p.cwd), p.path, p.scope),
    'git.log': async (p) => ({ commits: await git.log(absCwd(p.cwd), p.limit ?? 20) }),
    'git.commitShow': (p) => git.commitShow(absCwd(p.cwd), requireString(p.hash, 'hash')),
    'git.stage': (p) => git.stage(absCwd(p.cwd), p.paths, p.all),
    'git.unstage': (p) => git.unstage(absCwd(p.cwd), p.paths, p.all),
    'git.discard': (p) => git.discard(absCwd(p.cwd), p.paths, p.confirm),
    'git.commit': (p) => git.commit(absCwd(p.cwd), requireString(p.message, 'message'), { all: p.all, amend: p.amend }),
    'git.branches': async (p) => ({ branches: await git.branches(absCwd(p.cwd)) }),
    'git.checkout': (p) => git.checkout(absCwd(p.cwd), requireString(p.branch, 'branch')),
    'git.createBranch': (p) => git.createBranch(absCwd(p.cwd), requireString(p.name, 'name'), { from: p.from, checkout: p.checkout }),
    'git.deleteBranch': (p) => git.deleteBranch(absCwd(p.cwd), requireString(p.name, 'name'), { force: p.force, confirmForce: p.confirmForce }),
    'git.fetch': (p) => git.fetch(absCwd(p.cwd), p.remote, p.prune),
    'git.pull': (p) => git.pull(absCwd(p.cwd), { remote: p.remote, branch: p.branch, rebase: p.rebase }),
    'git.push': (p) =>
      git.push(absCwd(p.cwd), { remote: p.remote, branch: p.branch, setUpstream: p.setUpstream, force: p.force, confirmForce: p.confirmForce }),
    'git.conflicts': (p) => git.conflicts(absCwd(p.cwd)),
    'git.resolveConflict': (p) => git.resolveConflict(absCwd(p.cwd), requireString(p.path, 'path'), p.strategy, p.content),
    'git.abortConflict': (p) => git.abortConflict(absCwd(p.cwd), p.confirm),
    'git.worktrees': async (p) => ({ worktrees: await git.listWorktrees(absCwd(p.cwd)) }),
    'git.worktreeAdd': (p) =>
      git.addWorktree(absCwd(p.cwd), { path: p.path, branch: p.branch, newBranch: p.newBranch, baseRef: p.baseRef, taskSlug: p.taskSlug }),
    'git.worktreeRemove': async (p) => {
      await git.removeWorktree(absCwd(p.cwd), worktreePath(p), { force: p.force, confirmDirty: p.confirmDirty, deleteBranch: p.deleteBranch });
      return { removed: true };
    },
    'git.worktreePrune': async (p) => ({ worktrees: await git.pruneWorktrees(absCwd(p.cwd)) }),
    'git.worktreeCompare': (p) => git.compareWorktree(absCwd(p.cwd), worktreePath(p), p.baseBranch),
    'git.worktreeMerge': (p) =>
      git.mergeWorktree(absCwd(p.cwd), worktreePath(p), { targetBranch: p.targetBranch, squash: p.squash, confirm: p.confirm, removeAfter: p.removeAfter }),
    'git.prStatus': (p) => github.detectGhStatus(absCwd(p.cwd)),
    'git.prList': async (p) => ({ prs: await github.listPrs(absCwd(p.cwd), { state: p.state, limit: p.limit }) }),
    'git.prView': (p) => github.viewPr(absCwd(p.cwd), p.number),
    'git.prDiff': (p) => github.diffPr(absCwd(p.cwd), p.number),
    'git.prCreate': (p) => github.createPr(absCwd(p.cwd), { title: p.title, body: p.body, base: p.base, head: p.head, draft: p.draft }),
    'git.sessionPrGet': (p) => ({ link: sessionPrs.get(requireString(p.sessionId, 'sessionId')) ?? null }),
    'git.sessionPrLink': (p) => {
      const link = p.link ?? p;
      return {
        link: sessionPrs.link(requireString(p.sessionId, 'sessionId'), {
          cwd: absCwd(link.cwd),
          number: link.number,
          url: link.url,
          title: link.title,
          state: link.state,
          headRefName: link.headRefName,
          baseRefName: link.baseRefName,
          linkedAt: link.linkedAt,
        }),
      };
    },
    'git.sessionPrUnlink': (p) => ({ removed: sessionPrs.unlink(requireString(p.sessionId, 'sessionId')) }),
  };

  return {
    sessionPrs,
    /** `undefined` when `type` is not a git request. */
    handle(type: string, p: Json): Promise<Json> | undefined {
      const fn = Object.hasOwn(handlers, type) ? handlers[type] : undefined;
      return fn ? Promise.resolve().then(() => fn(p)) : undefined;
    },
  };
}
