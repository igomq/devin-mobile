import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX = 4 * 1024 * 1024;

async function git(cwd: string, args: string[], allowFail = false): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: MAX * 4 });
    return stdout;
  } catch (e: any) {
    if (allowFail && typeof e?.stdout === 'string') return e.stdout;
    throw new Error((e?.stderr || e?.message || 'git failed').toString().trim());
  }
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  head: string | null;
  files: ChangedFile[];
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export async function status(cwd: string): Promise<GitStatus> {
  if (!(await isRepo(cwd))) return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, head: null, files: [] };
  const out = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  const res: GitStatus = { isRepo: true, branch: null, upstream: null, ahead: 0, behind: 0, head: null, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) res.branch = line.slice(14);
    else if (line.startsWith('# branch.oid ')) res.head = line.slice(13) === '(initial)' ? null : line.slice(13, 13 + 12);
    else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        res.ahead = +m[1];
        res.behind = +m[2];
      }
    } else if (line[0] === '1' || line[0] === '2') {
      const f = line.split(' ');
      const xy = f[1];
      const path = line[0] === '1' ? f.slice(8).join(' ') : f.slice(9).join(' ');
      const file: ChangedFile = { path, index: xy[0], worktree: xy[1], status: 'modified', additions: 0, deletions: 0, binary: false };
      if (line[0] === '2') {
        file.oldPath = parts[++i];
        file.status = 'renamed';
      } else if (xy.includes('A')) file.status = 'added';
      else if (xy.includes('D')) file.status = 'deleted';
      res.files.push(file);
    } else if (line[0] === 'u') {
      const f = line.split(' ');
      res.files.push({ path: f.slice(10).join(' '), index: 'U', worktree: 'U', status: 'conflict', additions: 0, deletions: 0, binary: false });
    } else if (line[0] === '?') {
      res.files.push({ path: line.slice(2), index: '?', worktree: '?', status: 'untracked', additions: 0, deletions: 0, binary: false });
    }
  }
  const hasHead = res.head !== null;
  const numstat = hasHead ? await git(cwd, ['diff', 'HEAD', '--numstat', '-z', '-M'], true) : await git(cwd, ['diff', '--cached', '--numstat', '-z'], true);
  const stats = parseNumstat(numstat);
  for (const f of res.files) {
    const st = stats.get(f.path);
    if (st) Object.assign(f, st);
    else if (f.status === 'untracked') {
      const d = await git(cwd, ['diff', '--no-index', '--numstat', '--', '/dev/null', f.path], true);
      const m = /^(\d+|-)\t(\d+|-)/.exec(d);
      if (m) {
        f.binary = m[1] === '-';
        f.additions = f.binary ? 0 : +m[1];
      }
    }
  }
  return res;
}

function parseNumstat(out: string) {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(p);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      i++; // old path
      path = parts[++i];
    }
    map.set(path, { additions: m[1] === '-' ? 0 : +m[1], deletions: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' });
  }
  return map;
}

/** Unified diff of the working tree against HEAD (including untracked files). */
export async function diff(cwd: string, path?: string): Promise<{ diff: string; truncated: boolean }> {
  const st = await status(cwd);
  if (!st.isRepo) throw new Error('Not a git repository');
  const targets = path ? st.files.filter((f) => f.path === path) : st.files;
  let out = '';
  const tracked = targets.filter((f) => f.status !== 'untracked').map((f) => f.path);
  if (tracked.length) {
    const base = st.head ? ['diff', 'HEAD', '-M', '--no-color'] : ['diff', '--cached', '--no-color'];
    out += await git(cwd, [...base, '--', ...tracked], true);
  }
  for (const f of targets.filter((f) => f.status === 'untracked')) {
    if (out.length > MAX) break;
    out += await git(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', f.path], true);
  }
  const truncated = out.length > MAX;
  return { diff: truncated ? out.slice(0, MAX) : out, truncated };
}

export async function log(cwd: string, n = 20) {
  if (!(await isRepo(cwd))) return [];
  const out = await git(cwd, ['log', `-n${n}`, '--pretty=format:%h%x1f%s%x1f%an%x1f%ct'], true);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, ts] = l.split('\x1f');
      return { hash, subject, author, time: +ts * 1000 };
    });
}

export async function branch(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return null;
  }
}
