import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import * as git from './git.js';
import * as github from './github.js';

type Json = any;

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${name} is required`);
  return v;
}
function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

/**
 * Git, worktree and GitHub PR requests (`git.*`). Returns `undefined` for request types it does not own,
 * so the gateway's request handler can delegate with a single call.
 */
export interface GitRpcOptions {
  /** Called with every successful `git.status` result, keyed by the requested cwd. */
  onStatus?: (cwd: string, status: git.GitStatus) => void;
  /** Canonicalizes a requested path and throws when it is outside the gateway's allowed roots. */
  checkPath?: (path: string) => string;
}

export function createGitRpc(dataDir: string, opts: GitRpcOptions = {}) {
  const sessionPrs = new github.SessionPrStore(dataDir);
  const checkPath = opts.checkPath ?? ((path: string) => path);
  /** Resolves the request cwd; with root checks on, the repository it belongs to must be allowed too. */
  async function cwdOf(v: unknown): Promise<string> {
    const cwd = checkPath(resolve(expandHome(requireString(v, 'cwd'))));
    if (opts.checkPath && await git.isRepo(cwd)) checkPath(await git.repoRoot(cwd));
    return cwd;
  }
  function pathIn(cwd: string, v: unknown, name: string): string {
    const p = expandHome(requireString(v, name));
    return checkPath(isAbsolute(p) ? resolve(p) : resolve(cwd, p));
  }
  /** With root checks on, linked worktrees outside the allowed roots are left out of listings. */
  const visible = opts.checkPath
    ? (path: string) => {
      try {
        opts.checkPath!(path);
        return true;
      } catch {
        return false;
      }
    }
    : undefined;
  const worktreePath = (cwd: string, p: Json) => pathIn(cwd, p.worktreePath ?? p.path, 'worktreePath');
  const handlers: Record<string, (p: Json) => Promise<Json> | Json> = {
    'git.status': async (p) => {
      const cwd = await cwdOf(p.cwd);
      const st = await git.status(cwd);
      if (st.isRepo) opts.onStatus?.(cwd, st);
      return st;
    },
    'git.diff': async (p) => git.diff(await cwdOf(p.cwd), p.path, p.scope),
    'git.log': async (p) => ({ commits: await git.log(await cwdOf(p.cwd), p.limit ?? 20) }),
    'git.commitShow': async (p) => git.commitShow(await cwdOf(p.cwd), requireString(p.hash, 'hash')),
    'git.stage': async (p) => git.stage(await cwdOf(p.cwd), p.paths, p.all),
    'git.unstage': async (p) => git.unstage(await cwdOf(p.cwd), p.paths, p.all),
    'git.discard': async (p) => git.discard(await cwdOf(p.cwd), p.paths, p.confirm),
    'git.commit': async (p) => git.commit(await cwdOf(p.cwd), requireString(p.message, 'message'), { all: p.all, amend: p.amend }),
    'git.branches': async (p) => ({ branches: await git.branches(await cwdOf(p.cwd)) }),
    'git.checkout': async (p) => git.checkout(await cwdOf(p.cwd), requireString(p.branch, 'branch')),
    'git.createBranch': async (p) => git.createBranch(await cwdOf(p.cwd), requireString(p.name, 'name'), { from: p.from, checkout: p.checkout }),
    'git.deleteBranch': async (p) => git.deleteBranch(await cwdOf(p.cwd), requireString(p.name, 'name'), { force: p.force, confirmForce: p.confirmForce }),
    'git.fetch': async (p) => git.fetch(await cwdOf(p.cwd), p.remote, p.prune),
    'git.pull': async (p) => git.pull(await cwdOf(p.cwd), { remote: p.remote, branch: p.branch, rebase: p.rebase }),
    'git.push': async (p) =>
      git.push(await cwdOf(p.cwd), { remote: p.remote, branch: p.branch, setUpstream: p.setUpstream, force: p.force, confirmForce: p.confirmForce }),
    'git.conflicts': async (p) => git.conflicts(await cwdOf(p.cwd)),
    'git.resolveConflict': async (p) => git.resolveConflict(await cwdOf(p.cwd), requireString(p.path, 'path'), p.strategy, p.content),
    'git.abortConflict': async (p) => git.abortConflict(await cwdOf(p.cwd), p.confirm),
    'git.worktrees': async (p) => ({ worktrees: await git.listWorktrees(await cwdOf(p.cwd), visible) }),
    'git.worktreeAdd': async (p) =>
      git.addWorktree(await cwdOf(p.cwd), { path: p.path, checkPath: opts.checkPath, branch: p.branch, newBranch: p.newBranch, baseRef: p.baseRef, taskSlug: p.taskSlug }),
    'git.worktreeRemove': async (p) => {
      const cwd = await cwdOf(p.cwd);
      await git.removeWorktree(cwd, worktreePath(cwd, p), { force: p.force, confirmDirty: p.confirmDirty, deleteBranch: p.deleteBranch });
      return { removed: true };
    },
    'git.worktreePrune': async (p) => ({ worktrees: await git.pruneWorktrees(await cwdOf(p.cwd), visible) }),
    'git.worktreeCompare': async (p) => {
      const cwd = await cwdOf(p.cwd);
      return git.compareWorktree(cwd, worktreePath(cwd, p), p.baseBranch);
    },
    'git.worktreeMerge': async (p) => {
      const cwd = await cwdOf(p.cwd);
      return git.mergeWorktree(cwd, worktreePath(cwd, p), { targetBranch: p.targetBranch, squash: p.squash, confirm: p.confirm, removeAfter: p.removeAfter, checkPath: opts.checkPath });
    },
    'git.prStatus': async (p) => github.detectGhStatus(await cwdOf(p.cwd)),
    'git.prList': async (p) => ({ prs: await github.listPrs(await cwdOf(p.cwd), { state: p.state, limit: p.limit }) }),
    'git.prView': async (p) => github.viewPr(await cwdOf(p.cwd), p.number),
    'git.prDiff': async (p) => github.diffPr(await cwdOf(p.cwd), p.number),
    'git.prCreate': async (p) => github.createPr(await cwdOf(p.cwd), { title: p.title, body: p.body, base: p.base, head: p.head, draft: p.draft }),
    'git.sessionPrGet': async (p) => ({ link: sessionPrs.get(requireString(p.sessionId, 'sessionId')) ?? null }),
    'git.sessionPrLink': async (p) => {
      const link = p.link ?? p;
      return {
        link: sessionPrs.link(requireString(p.sessionId, 'sessionId'), {
          cwd: await cwdOf(link.cwd),
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
    'git.sessionPrUnlink': async (p) => ({ removed: sessionPrs.unlink(requireString(p.sessionId, 'sessionId')) }),
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
