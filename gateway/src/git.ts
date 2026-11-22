import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, open, readFile, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_DIFF = 4 * 1024 * 1024;
const patchFlags = ['-M', '--no-color'];

function gitOptions(cwd: string, env?: NodeJS.ProcessEnv) {
  return { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: MAX_DIFF * 4 };
}

async function gitResult(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  try {
    const { stdout, stderr } = await run('git', args, gitOptions(cwd, env));
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    if (typeof failure.code !== 'number') throw error;
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code };
  }
}

type GitResult = Awaited<ReturnType<typeof gitResult>>;

function gitError(result: GitResult): Error {
  return new Error((result.stderr || result.stdout).trim() || `git exited with status ${result.code}`);
}

async function git(cwd: string, args: string[], acceptedExitCode = 0, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await gitResult(cwd, args, env);
  if (result.code !== 0 && result.code !== acceptedExitCode) throw gitError(result);
  return result.stdout;
}

function commandOutput({ stdout, stderr }: GitResult): string {
  return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
}

async function patch(cwd: string, args: string[], limit = MAX_DIFF, acceptedExitCode = 0) {
  try {
    const { stdout } = await run('git', args, {
      ...gitOptions(cwd), encoding: 'buffer', maxBuffer: limit + 1,
    });
    return stdout;
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer; code?: number | string };
    if (failure.stdout && (failure.code === acceptedExitCode || failure.stdout.length > limit)) {
      return failure.stdout;
    }
    throw new Error(failure.stderr?.toString().trim() || (error as Error).message);
  }
}

function diffResult(buffers: Buffer[], size: number) {
  const truncated = size > MAX_DIFF;
  const output = Buffer.concat(buffers).subarray(0, MAX_DIFF);
  const diff = truncated ? new StringDecoder('utf8').write(output) : output.toString('utf8');
  if (Buffer.byteLength(diff) > MAX_DIFF) {
    return { diff: new StringDecoder('utf8').write(Buffer.from(diff).subarray(0, MAX_DIFF)), truncated: true };
  }
  return { diff, truncated };
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
  staged: boolean;
  unstaged: boolean;
}

type Operation = 'merge' | 'rebase' | 'cherry-pick';

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  head: string | null;
  files: ChangedFile[];
  repoRoot: string | null;
  detached: boolean;
  hasConflicts: boolean;
  operation: Operation | null;
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** Git status paths are relative to the top level even when cwd is a subdirectory. */
async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
}

async function emptyTree(cwd: string): Promise<string> {
  return (await git(cwd, ['hash-object', '-t', 'tree', '--', '/dev/null'])).trim();
}

async function activeOperation(cwd: string): Promise<Operation | null> {
  const dir = (await git(cwd, ['rev-parse', '--git-dir'])).replace(/\r?\n$/, '');
  const markers = [
    ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ] as const;
  for (const [marker, operation] of markers) {
    try {
      await access(resolve(cwd, dir, marker));
      return operation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function changedFile(path: string, index: string, worktree: string, kind: ChangedFile['status']): ChangedFile {
  return {
    path, index, worktree, status: kind, additions: 0, deletions: 0, binary: false,
    staged: index !== '.' && index !== '?' && index !== ' ',
    unstaged: worktree !== '.' && worktree !== ' ',
  };
}

type RepoStatus = GitStatus & { repoRoot: string };

async function readStatus(root: string, enforceSubmoduleStatus = false): Promise<RepoStatus> {
  const res: RepoStatus = {
    isRepo: true, branch: null, upstream: null, ahead: 0, behind: 0, head: null, files: [],
    repoRoot: root, detached: false, hasConflicts: false, operation: null,
  };
  const args = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'];
  if (enforceSubmoduleStatus) args.push('--ignore-submodules=none');
  const parts = (await git(root, args)).split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith('# branch.head ')) res.branch = line.slice(14);
    else if (line.startsWith('# branch.oid ')) res.head = line.slice(13) === '(initial)' ? null : line.slice(13, 25);
    else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        res.ahead = +m[1];
        res.behind = +m[2];
      }
    } else if (line[0] === '1' || line[0] === '2') {
      const fields = line.split(' ');
      const xy = fields[1];
      const renamed = line[0] === '2';
      const kind = renamed ? 'renamed' : xy.includes('A') ? 'added' : xy.includes('D') ? 'deleted' : 'modified';
      const file = changedFile(fields.slice(renamed ? 9 : 8).join(' '), xy[0], xy[1], kind);
      if (renamed) file.oldPath = parts[++i];
      res.files.push(file);
    } else if (line[0] === 'u') {
      res.files.push(changedFile(line.split(' ').slice(10).join(' '), 'U', 'U', 'conflict'));
      res.hasConflicts = true;
    } else if (line[0] === '?') {
      res.files.push(changedFile(line.slice(2), '?', '?', 'untracked'));
    }
  }
  res.detached = res.branch === '(detached)';
  res.operation = await activeOperation(root);
  return res;
}

export async function status(cwd: string): Promise<GitStatus> {
  if (!(await isRepo(cwd))) {
    return {
      isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, head: null, files: [],
      repoRoot: null, detached: false, hasConflicts: false, operation: null,
    };
  }
  return enrichStatus(await readStatus(await repoRoot(cwd)));
}

async function enrichStatus(res: RepoStatus) {
  const root = res.repoRoot;
  const base = res.head ? 'HEAD' : await emptyTree(root);
  const stats = parseNumstat(await git(root, ['diff', base, '--numstat', '-z', '-M']));
  for (const file of res.files) {
    const stat = stats.get(file.path);
    if (stat) Object.assign(file, stat);
    else if (file.status === 'untracked' && !file.path.endsWith('/')) {
      const { stdout } = await gitResult(root, ['diff', '--no-index', '--numstat', '--', '/dev/null', file.path]);
      const m = /^(\d+|-)\t(\d+|-)/.exec(stdout);
      if (m) {
        file.binary = m[1] === '-';
        file.additions = file.binary ? 0 : +m[1];
      }
    }
  }
  return res;
}

interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

function parseNumstat(out: string) {
  const map = new Map<string, FileStat>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      i++; // Old name.
      path = parts[++i];
    }
    map.set(path, { path, additions: m[1] === '-' ? 0 : +m[1], deletions: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' });
  }
  return map;
}

type DiffScope = 'all' | 'staged' | 'unstaged';

export async function diff(cwd: string, path?: string, scope: DiffScope = 'all') {
  if (scope !== 'all' && scope !== 'staged' && scope !== 'unstaged') throw new Error('Invalid diff scope');
  if (!(await isRepo(cwd))) throw new Error('Not a git repository');
  const root = await repoRoot(cwd);
  const st = await readStatus(root);
  const targets = path ? st.files.filter((f) => f.path === path) : st.files;
  const tracked = targets.filter((f) => f.status !== 'untracked').flatMap((f) => f.oldPath ? [f.oldPath, f.path] : [f.path]);
  const buffers: Buffer[] = [];
  let size = 0;
  if (tracked.length) {
    const base = scope === 'staged' ? ['--cached'] : scope === 'all' ? [st.head ? 'HEAD' : await emptyTree(root)] : [];
    const out = await patch(root, ['--literal-pathspecs', 'diff', ...base, ...patchFlags, '--', ...tracked]);
    buffers.push(out);
    size = out.length;
  }
  if (scope !== 'staged') {
    for (const f of targets) {
      if (size > MAX_DIFF) break;
      if (f.status !== 'untracked' || f.path.endsWith('/')) continue;
      const out = await patch(root, ['diff', '--no-index', '--no-color', '--', '/dev/null', f.path], MAX_DIFF - size, 1);
      buffers.push(out);
      size += out.length;
    }
  }
  return diffResult(buffers, size);
}

export async function log(cwd: string, limit = 20) {
  if (!(await isRepo(cwd))) return [];
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid git log limit');
  const out = await git(cwd, ['log', '-z', `-n${limit}`, '--format=%h%x00%H%x00%s%x00%an%x00%ct%x00%D'], 128);
  const fields = out.split('\0');
  const commits = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const [hash, fullHash, subject, author, time, refs] = fields.slice(i, i + 6);
    commits.push({ hash, fullHash, subject, author, time: +time * 1000, refs: refs ? refs.split(', ') : [] });
  }
  return commits;
}

async function commitHash(cwd: string, ref: string): Promise<string> {
  if (typeof ref !== 'string' || !ref) throw new Error('A git commit reference is required');
  return (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
}

export async function commitShow(cwd: string, ref: string) {
  const hash = await commitHash(cwd, ref);
  const [metadata, stat, output] = await Promise.all([
    git(cwd, ['show', '-s', '--format=%s%x00%an%x00%ct%x00%b%x00', hash, '--']),
    git(cwd, ['show', '--format=', '--numstat', '-z', '-M', '--diff-merges=first-parent', hash, '--']),
    patch(cwd, ['show', '--format=', '--diff-merges=first-parent', ...patchFlags, hash, '--']),
  ]);
  const [subject, author, time, body] = metadata.split('\0');
  return { hash, subject, author, time: +time * 1000, body: body.trimEnd(), files: [...parseNumstat(stat).values()], ...diffResult([output], output.length) };
}

export async function branch(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

function changePaths(paths: string[] | undefined): string[] {
  if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !p || p.includes('\0'))) {
    throw new Error('Provide one or more file paths, or select all where supported');
  }
  return paths;
}

export async function stage(cwd: string, paths?: string[], all?: boolean) {
  const root = await repoRoot(cwd);
  await git(root, all === true ? ['add', '-A'] : ['--literal-pathspecs', 'add', '--', ...changePaths(paths)]);
  return status(root);
}

export async function unstage(cwd: string, paths?: string[], all?: boolean) {
  const root = await repoRoot(cwd);
  const requested = all === true ? ['.'] : changePaths(paths);
  const hasHead = (await gitResult(root, ['rev-parse', '--verify', 'HEAD'])).code === 0;
  const command = hasHead ? ['reset', 'HEAD'] : ['rm', '--cached', '-r', '-f', '--ignore-unmatch'];
  await git(root, ['--literal-pathspecs', ...command, '--', ...requested]);
  return status(root);
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function checkedFile(root: string, path: string) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('A file path is required');
  const inputParts = path.split(sep === '\\' ? /[\\/]/ : '/');
  if (inputParts.includes('..')) throw new Error('File path must stay inside the repository');
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error('File path must stay inside the repository');
  }
  const parts = local.split(sep);
  if (parts.some(part => part.toLowerCase() === '.git')) throw new Error('File path must stay outside .git');
  let parent = root;
  for (const component of parts.slice(0, -1)) {
    parent = resolve(parent, component);
    const stat = await lstatIfExists(parent);
    if (stat && !stat.isDirectory()) throw new Error('File path has a symlink or non-directory parent');
  }
  return { absolute, local: parts.join('/') };
}

export async function discard(cwd: string, paths: string[], confirm: boolean) {
  if (confirm !== true) throw new Error('Discarding changes requires confirm: true');
  const root = await realpath(await repoRoot(cwd));
  const files = await Promise.all(changePaths(paths).map(path => checkedFile(root, path)));
  const selected = new Map(files.map(file => [file.local, file.absolute]));
  const st = await readStatus(root);
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const file of st.files) {
    const absolute = selected.get(file.path);
    if (!absolute) continue;
    if (file.status === 'conflict') throw new Error(`Resolve the conflict before discarding changes to ${file.path}`);
    if (file.status === 'untracked') untracked.push(absolute);
    else if (file.unstaged) tracked.push(file.path);
  }
  for (const { absolute } of files) {
    if ((await lstatIfExists(absolute))?.isDirectory()) throw new Error('Discard expects individual file paths');
  }
  if (tracked.length) {
    await git(root, ['--literal-pathspecs', 'restore', '--worktree', '--', ...tracked]);
  }
  for (const absolute of untracked) await unlink(absolute);
  return status(root);
}

export async function commit(cwd: string, message: string, opts: { all?: boolean; amend?: boolean } = {}) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Commit message is required');
  const args = ['commit', '-m', message];
  if (opts.all === true) args.push('-a');
  if (opts.amend === true) args.push('--amend');
  await git(cwd, args);
  const [hash, subject] = (await git(cwd, ['log', '-1', '--format=%H%x00%s%x00'])).split('\0');
  return { hash, subject, status: await status(cwd) };
}

function shortBranch(ref: string) {
  return ref.replace(/^refs\/(?:heads|remotes)\//, '');
}

export async function branches(cwd: string) {
  const out = await git(cwd, [
    'for-each-ref', '--format=%(refname)%00%(HEAD)%00%(symref)%00%(upstream)%00%(upstream:track)%00%(objectname)%00%(subject)',
    'refs/heads', 'refs/remotes',
  ], 0, { LC_ALL: 'C' });
  return out.split('\n').filter(Boolean).flatMap(line => {
    const [ref, headMark, symref, upstream, tracking, head, subject] = line.split('\0');
    if (symref) return [];
    return [{
      name: shortBranch(ref), current: headMark === '*', remote: ref.startsWith('refs/remotes/'),
      upstream: upstream ? shortBranch(upstream) : null,
      ahead: Number(/ahead (\d+)/.exec(tracking)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(tracking)?.[1] ?? 0),
      head, subject,
    }];
  });
}

async function branchName(cwd: string, name: string): Promise<string> {
  if (typeof name !== 'string' || !name || name.startsWith('-')) {
    throw new Error('Invalid git branch name');
  }
  const result = await gitResult(cwd, ['check-ref-format', '--branch', name]);
  if (result.code !== 0 || result.stdout.trimEnd() !== name) throw new Error(`Invalid git branch name: ${name}`);
  return name;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await gitResult(cwd, ['show-ref', '--verify', '--quiet', ref])).code === 0;
}

export async function checkout(cwd: string, branch: string) {
  cwd = await repoRoot(cwd);
  const name = await branchName(cwd, branch);
  if (await refExists(cwd, `refs/heads/${name}`)) {
    await git(cwd, ['switch', '--no-guess', '--', name]);
  } else if (await refExists(cwd, `refs/remotes/${name}`)) {
    await git(cwd, ['switch', '--track', '--', `refs/remotes/${name}`]);
  } else {
    await git(cwd, ['switch', '--guess', '--', name]);
  }
  return status(cwd);
}

export async function createBranch(cwd: string, name: string, opts: { from?: string; checkout?: boolean } = {}) {
  if (opts.checkout !== false) cwd = await repoRoot(cwd);
  const target = await branchName(cwd, name);
  const from = opts.from === undefined ? [] : [await commitHash(cwd, opts.from)];
  if (opts.checkout === false) await git(cwd, ['branch', '--', target, ...from]);
  else await git(cwd, ['switch', '-c', target, '--', ...from]);
  return status(cwd);
}

interface ForceOptions {
  force?: boolean;
  confirmForce?: boolean;
}

export async function deleteBranch(cwd: string, name: string, opts: ForceOptions = {}) {
  if (opts.force === true && opts.confirmForce !== true) throw new Error('Force deleting a branch requires confirmForce: true');
  const target = await branchName(cwd, name);
  const current = await gitResult(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
  if (current.stdout.trimEnd() === `refs/heads/${target}`) throw new Error('Cannot delete the current branch');
  await git(cwd, ['branch', opts.force === true ? '-D' : '-d', '--', target]);
  return status(cwd);
}

async function remotes(cwd: string): Promise<string[]> {
  return (await git(cwd, ['remote'])).split('\n').filter(Boolean);
}

async function remoteName(cwd: string, remote: string): Promise<string> {
  if (typeof remote !== 'string' || !(await remotes(cwd)).includes(remote)) throw new Error('Unknown git remote');
  return remote;
}

interface RemoteOptions {
  remote?: string;
  branch?: string;
}

async function remoteArgs(cwd: string, opts: RemoteOptions, pushing: boolean): Promise<string[]> {
  const name = opts.branch === undefined ? undefined : await branchName(cwd, opts.branch);
  if (opts.remote === undefined && name === undefined) return [];
  let remote = opts.remote;
  if (remote === undefined) {
    const current = shortBranch((await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'], 1)).trimEnd());
    const configKeys = [
      ...(pushing ? [`branch.${current}.pushRemote`, 'remote.pushDefault'] : []),
      `branch.${current}.remote`,
    ];
    for (const key of configKeys) {
      remote = (await git(cwd, ['config', '--get', key], 1)).trimEnd();
      if (remote) break;
    }
    if (!remote) {
      const configured = await remotes(cwd);
      remote = configured.length === 1 ? configured[0] : 'origin';
    }
  }
  const selected = await remoteName(cwd, remote);
  const ref = name ? `refs/heads/${name}${pushing ? `:refs/heads/${name}` : ''}` : undefined;
  return ref ? ['--', selected, ref] : ['--', selected];
}

export async function fetch(cwd: string, remote?: string, prune?: boolean) {
  const args = ['fetch'];
  if (prune === true) args.push('--prune');
  if (remote === undefined) args.push('--all');
  else args.push('--', await remoteName(cwd, remote));
  const result = await gitResult(cwd, args);
  if (result.code !== 0) throw gitError(result);
  return { output: commandOutput(result), status: await status(cwd) };
}

export async function pull(cwd: string, opts: RemoteOptions & { rebase?: boolean } = {}) {
  cwd = await repoRoot(cwd);
  const args = ['pull', '--no-edit'];
  if (opts.rebase === true) args.push('--rebase');
  else if (opts.rebase === false) args.push('--no-rebase');
  const result = await gitResult(cwd, [...args, ...await remoteArgs(cwd, opts, false)]);
  const st = await status(cwd);
  if (result.code !== 0 && !st.hasConflicts) throw gitError(result);
  return { ok: result.code === 0, conflicts: st.hasConflicts, output: commandOutput(result), status: st };
}

export async function push(cwd: string, opts: RemoteOptions & ForceOptions & { setUpstream?: boolean } = {}) {
  if (opts.force === true && opts.confirmForce !== true) throw new Error('Force push requires confirmForce: true');
  const args = ['push'];
  if (opts.setUpstream === true) args.push('--set-upstream');
  if (opts.force === true) args.push('--force-with-lease');
  let branch = opts.branch;
  if (opts.setUpstream === true && branch === undefined) {
    branch = shortBranch((await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'], 1)).trimEnd());
    if (!branch) throw new Error('Specify a branch to set an upstream when HEAD is detached');
  }
  const result = await gitResult(cwd, [...args, ...await remoteArgs(cwd, { remote: opts.remote, branch }, true)]);
  if (result.code !== 0) throw gitError(result);
  return { output: commandOutput(result), status: await status(cwd) };
}

interface ConflictHunk {
  index: number;
  startLine: number;
  endLine: number;
  ours: string;
  theirs: string;
  base?: string;
}

function conflictHunks(content: string): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  let hunk: { markerSize: number; startLine: number; ours: string[]; base?: string[]; theirs: string[] } | undefined;
  let section: 'ours' | 'base' | 'theirs' = 'ours';
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^(<+|\|+|=+|>+)(?: [^\r]*)?\r?$/.exec(line)?.[1];
    if (!hunk && marker?.[0] === '<') {
      hunk = { markerSize: marker.length, startLine: i + 1, ours: [], theirs: [] };
      section = 'ours';
    } else if (hunk) {
      if (marker?.length === hunk.markerSize) {
        if (marker[0] === '|' && section === 'ours') {
          hunk.base = [];
          section = 'base';
          continue;
        }
        if (marker[0] === '=' && section !== 'theirs') {
          section = 'theirs';
          continue;
        }
        if (marker[0] === '>' && section === 'theirs') {
          hunks.push({
            index: hunks.length, startLine: hunk.startLine, endLine: i + 1,
            ours: hunk.ours.join('\n'), theirs: hunk.theirs.join('\n'),
            ...(hunk.base ? { base: hunk.base.join('\n') } : {}),
          });
          hunk = undefined;
          continue;
        }
      }
      hunk[section]?.push(line);
    }
  }
  return hunks;
}

export async function conflicts(cwd: string) {
  const root = await realpath(await repoRoot(cwd));
  const { files, operation } = await readStatus(root);
  const conflicted = [];
  for (const file of files.filter(f => f.status === 'conflict')) {
    const { absolute } = await checkedFile(root, file.path);
    const st = await lstatIfExists(absolute);
    const content = st?.isSymbolicLink() ? await readlink(absolute) : st?.isFile() ? await readFile(absolute, 'utf8') : '';
    conflicted.push({ path: file.path, content, hunks: conflictHunks(content) });
  }
  return { files: conflicted, operation };
}

export async function resolveConflict(cwd: string, path: string, strategy: 'ours' | 'theirs' | 'manual', content?: string) {
  const root = await realpath(await repoRoot(cwd));
  const { absolute, local } = await checkedFile(root, path);
  const st = await readStatus(root);
  if (!st.files.some(f => f.path === local && f.status === 'conflict')) throw new Error(`Path is not conflicted: ${local}`);
  const pathArgs = ['--', local];
  if (strategy === 'manual') {
    if (typeof content !== 'string') throw new Error('Manual conflict resolution requires string content');
    const existing = await lstatIfExists(absolute);
    if (existing && !existing.isFile()) throw new Error('Manual conflict resolution requires a regular file');
    const temp = join(dirname(absolute), `.uniharn-${randomUUID()}.tmp`);
    const file = await open(temp, 'wx', existing ? existing.mode & 0o777 : 0o666);
    try {
      try {
        await file.writeFile(content, 'utf8');
        if (existing) await file.chmod(existing.mode & 0o777);
      } finally {
        await file.close();
      }
      await rename(temp, absolute);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    await git(root, ['--literal-pathspecs', 'add', ...pathArgs]);
  } else if (strategy === 'ours' || strategy === 'theirs') {
    const entries = await git(root, ['--literal-pathspecs', 'ls-files', '-u', '-z', ...pathArgs]);
    const stageNumber = strategy === 'ours' ? 2 : 3;
    if (entries.split('\0').some(entry => entry.split('\t')[0].endsWith(` ${stageNumber}`))) {
      await git(root, ['--literal-pathspecs', 'checkout', `--${strategy}`, ...pathArgs]);
      await git(root, ['--literal-pathspecs', 'add', ...pathArgs]);
    } else {
      await git(root, ['--literal-pathspecs', 'rm', ...pathArgs]);
    }
  } else {
    throw new Error('Invalid conflict resolution strategy');
  }
  const updated = await status(root);
  return { status: updated, remaining: updated.files.filter(f => f.status === 'conflict').length };
}

export async function abortConflict(cwd: string, confirm: boolean) {
  if (confirm !== true) throw new Error('Aborting a Git operation requires confirm: true');
  const root = await repoRoot(cwd);
  const operation = await activeOperation(root);
  if (!operation) throw new Error('No merge, rebase, or cherry-pick is in progress');
  await git(root, [operation, '--abort']);
  return status(root);
}

interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

interface Worktree extends WorktreeEntry {
  dirtyCount: number;
  hasUncommittedChanges: boolean;
}

async function worktreeEntries(cwd: string): Promise<WorktreeEntry[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain', '-z']);
  return out.split('\0\0').filter(Boolean).map((record, index) => {
    const fields = record.split('\0');
    const branch = fields.find(field => field.startsWith('branch '));
    return {
      path: fields[0].slice('worktree '.length),
      head: fields.find(field => field.startsWith('HEAD '))?.slice(5) ?? null,
      branch: branch ? shortBranch(branch.slice(7)) : null,
      detached: fields.includes('detached'),
      bare: fields.includes('bare'),
      locked: fields.some(field => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some(field => field === 'prunable' || field.startsWith('prunable ')),
      isMain: index === 0,
    };
  });
}

async function worktreeStatus(cwd: string, entry: WorktreeEntry) {
  if (entry.bare || entry.prunable) throw new Error(`Worktree is not available: ${entry.path}`);
  const args = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  const [commonDir, selectedDir] = await Promise.all([git(cwd, args), git(entry.path, args)]);
  if (commonDir !== selectedDir || await repoRoot(entry.path) !== entry.path) {
    throw new Error(`Worktree no longer matches this repository: ${entry.path}`);
  }
  return readStatus(entry.path, true);
}

async function enrichWorktree(cwd: string, item: WorktreeEntry): Promise<Worktree> {
  // A locked worktree may be on an unavailable volume and is not marked prunable.
  const available = !item.bare && !item.prunable && await lstatIfExists(item.path);
  const dirtyCount = available ? (await worktreeStatus(cwd, item)).files.length : 0;
  return { ...item, dirtyCount, hasUncommittedChanges: dirtyCount > 0 };
}

export async function listWorktrees(cwd: string) {
  const entries = await worktreeEntries(cwd);
  return Promise.all(entries.map(entry => enrichWorktree(cwd, entry)));
}

async function pathOrResolved(path: string) {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path;
  }
}

async function findWorktree(entries: WorktreeEntry[], cwd: string, path: string) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('A worktree path is required');
  const absolute = await pathOrResolved(resolve(cwd, path));
  const entry = entries.find(w => w.path === absolute);
  if (!entry) throw new Error(`Worktree not found: ${path}`);
  return entry;
}

function slug(value: string) {
  if (typeof value !== 'string') throw new Error('Invalid worktree slug');
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
}

interface AddWorktreeOptions {
  path?: string;
  branch?: string;
  newBranch?: string;
  baseRef?: string;
  taskSlug?: string;
}

export async function addWorktree(cwd: string, opts: AddWorktreeOptions) {
  const [main] = await worktreeEntries(cwd);
  let newBranch = opts.newBranch;
  if (newBranch === undefined && opts.taskSlug !== undefined) {
    const taskSlug = slug(opts.taskSlug);
    if (!taskSlug) throw new Error('Invalid worktree task slug');
    newBranch = `uniharn/${taskSlug}`;
  }
  const args = ['worktree', 'add'];
  let start: string;
  if (newBranch !== undefined) {
    await branchName(cwd, newBranch);
    args.push('-b', newBranch);
    start = await commitHash(cwd, opts.baseRef ?? opts.branch ?? 'HEAD');
  } else if (opts.branch !== undefined) {
    start = await branchName(cwd, opts.branch);
    if (!await refExists(cwd, `refs/heads/${start}`)) throw new Error(`Local branch not found: ${start}`);
  } else {
    args.push('--detach');
    start = await commitHash(cwd, opts.baseRef ?? 'HEAD');
  }
  const branchSlug = slug(newBranch ?? opts.branch ?? opts.baseRef ?? start).slice(0, 120) || 'worktree';
  const repoSlug = slug(basename(main.path)).slice(0, 100) || 'repo';
  if (opts.path !== undefined && (typeof opts.path !== 'string' || !opts.path || opts.path.includes('\0'))) {
    throw new Error('Invalid worktree path');
  }
  const path = opts.path === undefined
    ? resolve(dirname(main.path), '.uniharn-worktrees', `${repoSlug}-${branchSlug}`)
    : resolve(cwd, opts.path);
  await git(cwd, [...args, '--', path, start]);
  return enrichWorktree(cwd, await findWorktree(await worktreeEntries(cwd), cwd, path));
}

interface RemoveWorktreeOptions {
  force?: boolean;
  confirmDirty?: boolean;
  deleteBranch?: boolean;
}

export async function removeWorktree(cwd: string, worktreePath: string, opts: RemoveWorktreeOptions = {}) {
  const entries = await worktreeEntries(cwd);
  const entry = await findWorktree(entries, cwd, worktreePath);
  if (entry.isMain) throw new Error('Cannot remove the main worktree');
  const st = await worktreeStatus(cwd, entry);
  const force = opts.force === true && opts.confirmDirty === true;
  if ((st.files.length || st.operation) && !force) {
    throw new Error('Worktree has uncommitted changes or a Git operation in progress. Removal requires force: true and confirmDirty: true');
  }
  // Run from the main worktree so removing the caller's worktree does not invalidate cwd.
  const main = entries[0].path;
  await git(main, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', entry.path]);
  if (opts.deleteBranch === true && entry.branch) {
    const result = await gitResult(main, ['branch', force ? '-D' : '-d', '--', entry.branch]);
    if (result.code !== 0) throw new Error(`Worktree removed. Branch retained: ${gitError(result).message}`);
  }
}

export async function pruneWorktrees(cwd: string) {
  await git(cwd, ['worktree', 'prune']);
  return listWorktrees(cwd);
}

async function defaultBase(cwd: string, main: WorktreeEntry) {
  if (main.branch) return main.branch;
  for (const name of ['master', 'main']) {
    if (await refExists(cwd, `refs/heads/${name}`)) return name;
  }
  throw new Error('Specify a base branch when the main worktree has no current branch');
}

async function divergence(cwd: string, target: string, head: string) {
  const [behind, ahead] = (await git(cwd, ['rev-list', '--left-right', '--count', `${target}...${head}`])).trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

export async function compareWorktree(cwd: string, worktreePath: string, baseBranch?: string) {
  const entries = await worktreeEntries(cwd);
  const entry = await findWorktree(entries, cwd, worktreePath);
  const worktree = await worktreeStatus(cwd, entry);
  const base = baseBranch ?? await defaultBase(cwd, entries[0]);
  const [target, head, st] = await Promise.all([commitHash(cwd, base), commitHash(entry.path, 'HEAD'), enrichStatus(worktree)]);
  const [{ ahead, behind }, baseResult] = await Promise.all([
    divergence(cwd, target, head),
    gitResult(cwd, ['merge-base', target, head]),
  ]);
  if (baseResult.code !== 0 && baseResult.code !== 1) throw gitError(baseResult);
  const ancestor = baseResult.code === 0 ? baseResult.stdout.trim() : await emptyTree(entry.path);
  const [numstat, output] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-z', '-M', ancestor, head, '--']),
    patch(cwd, ['diff', ...patchFlags, ancestor, head, '--']),
  ]);
  return {
    worktreePath: entry.path, branch: entry.branch, baseBranch: base, ahead, behind,
    uncommittedFiles: st.files, committedFiles: [...parseNumstat(numstat).values()], ...diffResult([output], output.length),
  };
}

interface MergeWorktreeOptions {
  targetBranch?: string;
  squash?: boolean;
  confirm?: boolean;
  removeAfter?: boolean;
}

function requireCleanWorktree(st: GitStatus, label: string) {
  if (st.files.length) throw new Error(`${label} has uncommitted changes. Commit or stash them before merging`);
  if (st.operation) throw new Error(`${label} has a Git operation in progress. Finish or abort it before merging`);
}

export async function mergeWorktree(cwd: string, worktreePath: string, opts: MergeWorktreeOptions = {}) {
  const entries = await worktreeEntries(cwd);
  const entry = await findWorktree(entries, cwd, worktreePath);
  const st = await worktreeStatus(cwd, entry);
  requireCleanWorktree(st, 'Source worktree');
  const targetBranch = await branchName(cwd, opts.targetBranch ?? await defaultBase(cwd, entries[0]));
  const targetEntry = entries.find(w => w.branch === targetBranch) ?? entries[0];
  if (targetEntry.path === entry.path) throw new Error('Source and target must use different worktrees');
  const targetStatus = await worktreeStatus(cwd, targetEntry);
  requireCleanWorktree(targetStatus, 'Target worktree');
  const [target, head] = await Promise.all([commitHash(cwd, `refs/heads/${targetBranch}`), commitHash(entry.path, 'HEAD')]);

  if (opts.confirm !== true) {
    const [{ ahead, behind }, preview] = await Promise.all([
      divergence(cwd, target, head),
      gitResult(cwd, ['merge-tree', '--write-tree', '--name-only', '-z', target, head]),
    ]);
    const supported = preview.code !== 129;
    if (supported && preview.code !== 0 && preview.code !== 1) throw gitError(preview);
    const conflictFiles: string[] = [];
    if (preview.code === 1) {
      for (const path of preview.stdout.split('\0').slice(1)) {
        if (!path) break;
        conflictFiles.push(path);
      }
    }
    return {
      preview: true as const, canFastForward: behind === 0, hasConflicts: preview.code === 1,
      conflictFiles, ahead, branch: entry.branch, targetBranch,
      ...(!supported ? { conflictCheckSupported: false } : {}),
    };
  }

  if (targetStatus.branch !== targetBranch) {
    await git(targetEntry.path, ['switch', '--no-guess', '--', targetBranch]);
  }
  const result = await gitResult(targetEntry.path, ['merge', '--no-edit', ...(opts.squash === true ? ['--squash'] : []), head]);
  const updated = await status(targetEntry.path);
  if (result.code !== 0 && !updated.hasConflicts) throw gitError(result);
  if (result.code === 0 && opts.removeAfter === true) {
    try {
      await removeWorktree(targetEntry.path, entry.path);
    } catch (error) {
      throw new Error(`Merge into ${targetBranch} succeeded, but worktree removal failed: ${(error as Error).message}`);
    }
  }
  return {
    merged: result.code === 0, conflicts: updated.hasConflicts,
    conflictFiles: updated.files.filter(f => f.status === 'conflict').map(f => f.path), status: updated,
  };
}
