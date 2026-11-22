import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as git from '../src/git.js';

before(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_TERMINAL_PROMPT = '0';
});

interface Fixture {
  root: string;
  repo: string;
  remote: string;
}

function runGit(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function write(repo: string, path: string, contents: string) {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commit(repo: string, subject: string) {
  runGit(repo, ['add', '-A']);
  runGit(repo, ['commit', '-m', subject]);
  return runGit(repo, ['rev-parse', 'HEAD']);
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uniharn-git-test-')));
  const remote = join(root, 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  runGit(root, ['init', '--bare', '--initial-branch=main', remote]);
  runGit(repo, ['init', '--initial-branch=main']);
  runGit(repo, ['config', 'user.name', 'Git Test']);
  runGit(repo, ['config', 'user.email', 'git-test@example.invalid']);
  write(repo, 'README.md', 'base line\nstable line\n');
  commit(repo, 'initial commit');
  runGit(repo, ['remote', 'add', 'origin', remote]);
  runGit(repo, ['push', '--set-upstream', 'origin', 'main']);
  return { root, repo, remote };
}

async function withRepo(run: (fixture: Fixture) => Promise<void>) {
  const fixture = createFixture();
  try {
    await run(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function cloneRemote(fixture: Fixture, name = 'peer') {
  const path = join(fixture.root, name);
  runGit(fixture.root, ['clone', fixture.remote, path]);
  runGit(path, ['config', 'user.name', 'Peer Test']);
  runGit(path, ['config', 'user.email', 'peer-test@example.invalid']);
  return path;
}

test('status reports clean and changed files from the repository root for a subdirectory cwd', async () => {
  await withRepo(async ({ root, repo }) => {
    assert.equal(await git.isRepo(repo), true);
    const clean = await git.status(repo);
    assert.equal(clean.isRepo, true);
    assert.equal(clean.branch, 'main');
    assert.equal(clean.upstream, 'origin/main');
    assert.equal(clean.ahead, 0);
    assert.equal(clean.behind, 0);
    assert.equal(clean.head, runGit(repo, ['rev-parse', '--short=12', 'HEAD']));
    assert.equal(clean.repoRoot, repo);
    assert.deepEqual(clean.files, []);

    const outside = join(root, 'not-a-repository');
    mkdirSync(outside);
    assert.equal(await git.isRepo(outside), false);
    assert.deepEqual(await git.status(outside), {
      isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, head: null, files: [],
      repoRoot: null, detached: false, hasConflicts: false, operation: null,
    });

    write(repo, 'nested directory/tracked file.txt', 'base tracked line\nstable line\n');
    commit(repo, 'add nested tracked file');
    const changedBase = runGit(repo, ['rev-parse', '--short=12', 'HEAD']);
    write(repo, 'nested directory/tracked file.txt', 'staged line\nstable line\n');
    write(repo, 'nested directory/staged addition.txt', 'one\ntwo\n');
    await git.stage(repo, ['nested directory/tracked file.txt', 'nested directory/staged addition.txt']);
    write(repo, 'nested directory/tracked file.txt', 'working line\nstable line\n');
    write(repo, 'nested directory/untracked file.txt', 'untracked\n');

    const nested = join(repo, 'nested directory');
    const status = await git.status(nested);
    assert.equal(status.repoRoot, repo);
    assert.equal(status.head, changedBase);
    const byPath = new Map(status.files.map((file) => [file.path, file]));
    assert.deepEqual([...byPath.keys()].sort(), [
      'nested directory/staged addition.txt',
      'nested directory/tracked file.txt',
      'nested directory/untracked file.txt',
    ]);
    assert.deepEqual(
      (({ index, worktree, status, staged, unstaged }) => ({ index, worktree, status, staged, unstaged }))(
        byPath.get('nested directory/tracked file.txt')!,
      ),
      { index: 'M', worktree: 'M', status: 'modified', staged: true, unstaged: true },
    );
    assert.deepEqual(
      (({ index, worktree, status, staged, unstaged, additions }) => ({ index, worktree, status, staged, unstaged, additions }))(
        byPath.get('nested directory/staged addition.txt')!,
      ),
      { index: 'A', worktree: '.', status: 'added', staged: true, unstaged: false, additions: 2 },
    );
    assert.deepEqual(
      (({ index, worktree, status, staged, unstaged, additions }) => ({ index, worktree, status, staged, unstaged, additions }))(
        byPath.get('nested directory/untracked file.txt')!,
      ),
      { index: '?', worktree: '?', status: 'untracked', staged: false, unstaged: true, additions: 1 },
    );

    runGit(repo, ['checkout', '--detach', 'HEAD']);
    const detached = await git.status(nested);
    assert.equal(detached.detached, true);
    assert.equal(detached.branch, '(detached)');
  });
});

test('status reports ahead and behind counts after fetching an independently updated remote', async () => {
  await withRepo(async (fixture) => {
    const peer = cloneRemote(fixture);
    write(peer, 'remote.txt', 'from remote\n');
    commit(peer, 'remote update');
    runGit(peer, ['push', 'origin', 'main']);

    write(fixture.repo, 'local.txt', 'from local\n');
    commit(fixture.repo, 'local update');
    await git.fetch(fixture.repo);

    const status = await git.status(fixture.repo);
    assert.equal(status.ahead, 1);
    assert.equal(status.behind, 1);
    assert.equal(status.upstream, 'origin/main');
  });
});

test('diff returns all, staged, and unstaged patches and honors literal paths', async () => {
  await withRepo(async ({ repo }) => {
    write(repo, 'nested/literal [name].txt', 'staged version\nstable line\n');
    write(repo, 'nested/other.txt', 'staged only\n');
    await git.stage(repo, ['nested/literal [name].txt', 'nested/other.txt']);
    write(repo, 'nested/literal [name].txt', 'working version\nstable line\n');
    write(repo, 'untracked [file].txt', 'brand new\n');

    const all = await git.diff(repo);
    assert.match(all.diff, /working version/);
    assert.match(all.diff, /staged only/);
    assert.match(all.diff, /untracked \[file\]\.txt/);
    assert.equal(all.truncated, false);

    const staged = await git.diff(repo, undefined, 'staged');
    assert.match(staged.diff, /staged version/);
    assert.match(staged.diff, /staged only/);
    assert.doesNotMatch(staged.diff, /working version/);
    assert.doesNotMatch(staged.diff, /untracked \[file\]\.txt/);

    const unstaged = await git.diff(repo, undefined, 'unstaged');
    assert.match(unstaged.diff, /working version/);
    assert.doesNotMatch(unstaged.diff, /staged only/);
    assert.match(unstaged.diff, /untracked \[file\]\.txt/);

    const literal = await git.diff(repo, 'nested/literal [name].txt', 'staged');
    assert.match(literal.diff, /staged version/);
    assert.doesNotMatch(literal.diff, /staged only/);
    await assert.rejects(git.diff(repo, undefined, 'invalid' as never), /Invalid diff scope/);
  });
});

test('stage, unstage, confirmed discard, commit, log, and commitShow operate on real files', async () => {
  await withRepo(async ({ repo }) => {
    write(repo, 'README.md', 'edited line\nstable line\n');
    const staged = await git.stage(repo, ['README.md']);
    assert.equal(staged.files[0]?.index, 'M');
    assert.equal(staged.files[0]?.staged, true);

    const unstaged = await git.unstage(repo, ['README.md']);
    assert.equal(unstaged.files[0]?.index, '.');
    assert.equal(unstaged.files[0]?.worktree, 'M');
    await assert.rejects(git.discard(repo, ['README.md'], false), /confirm: true/);
    assert.match(readFileSync(join(repo, 'README.md'), 'utf8'), /edited line/);

    await git.discard(repo, ['README.md'], true);
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'base line\nstable line\n');
    write(repo, 'new [literal].txt', 'new file\n');
    await git.discard(repo, ['new [literal].txt'], true);
    assert.equal(existsSync(join(repo, 'new [literal].txt')), false);

    write(repo, 'feature.txt', 'committed content\n');
    await git.stage(repo, ['feature.txt']);
    const result = await git.commit(repo, 'add feature file');
    assert.match(result.hash, /^[0-9a-f]{40}$/);
    assert.equal(result.subject, 'add feature file');
    assert.deepEqual(result.status.files, []);

    const commits = await git.log(repo, 1);
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.subject, 'add feature file');
    assert.match(commits[0]?.fullHash ?? '', /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(commits[0]?.refs));
    assert.ok(commits[0]?.refs.some((ref: string) => ref.includes('HEAD -> main')));

    const shown = await git.commitShow(repo, commits[0]!.fullHash);
    assert.equal(shown.hash, commits[0]!.fullHash);
    assert.match(shown.diff, /committed content/);
    assert.ok(shown.files.some((file: { path: string }) => file.path === 'feature.txt'));
  });
});

test('discard rejects traversal and symlink-parent paths without touching outside files', async () => {
  await withRepo(async ({ root, repo }) => {
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'safe\n');
    await assert.rejects(git.discard(repo, ['../outside.txt'], true), /inside the repository/);
    assert.equal(readFileSync(outside, 'utf8'), 'safe\n');

    const outsideDir = join(root, 'outside-dir');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'keep.txt'), 'safe through symlink\n');
    symlinkSync(outsideDir, join(repo, 'linked-dir'), 'dir');
    await assert.rejects(git.discard(repo, ['linked-dir/keep.txt'], true), /symlink/);
    assert.equal(readFileSync(join(outsideDir, 'keep.txt'), 'utf8'), 'safe through symlink\n');
  });
});

test('branch listing, creation, checkout, safe deletion, and confirmed force deletion', async () => {
  await withRepo(async ({ repo }) => {
    const created = await git.createBranch(repo, 'feature/safe-delete');
    assert.equal(created.branch, 'feature/safe-delete');
    assert.equal(await git.branch(repo), 'feature/safe-delete');
    assert.ok((await git.branches(repo)).some((branch) => branch.name === 'feature/safe-delete' && branch.current));
    await assert.rejects(git.deleteBranch(repo, 'feature/safe-delete'), /current branch/);

    await git.checkout(repo, 'main');
    await git.deleteBranch(repo, 'feature/safe-delete');
    assert.ok(!(await git.branches(repo)).some((branch) => branch.name === 'feature/safe-delete'));

    await git.createBranch(repo, 'feature/unmerged');
    write(repo, 'unmerged.txt', 'branch-only\n');
    commit(repo, 'unmerged branch commit');
    await git.checkout(repo, 'main');
    await assert.rejects(git.deleteBranch(repo, 'feature/unmerged'), /not fully merged|fully merged|unmerged/i);
    await assert.rejects(git.deleteBranch(repo, 'feature/unmerged', { force: true }), /confirmForce: true/);
    assert.ok((await git.branches(repo)).some((branch) => branch.name === 'feature/unmerged'));
    await git.deleteBranch(repo, 'feature/unmerged', { force: true, confirmForce: true });
    assert.ok(!(await git.branches(repo)).some((branch) => branch.name === 'feature/unmerged'));
  });
});

test('fetch and pull use the configured upstream, while push supports normal and set-upstream flows', async () => {
  await withRepo(async (fixture) => {
    const peer = cloneRemote(fixture);
    write(peer, 'from-peer.txt', 'remote update\n');
    commit(peer, 'peer update');
    runGit(peer, ['push', 'origin', 'main']);

    const fetched = await git.fetch(fixture.repo);
    assert.equal(fetched.status.behind, 1);
    write(fixture.repo, 'local-before-pull.txt', 'local\n');
    commit(fixture.repo, 'local commit before pull');
    const pulled = await git.pull(fixture.repo);
    assert.equal(pulled.ok, true);
    assert.equal(pulled.conflicts, false);
    assert.equal(existsSync(join(fixture.repo, 'from-peer.txt')), true);
    assert.equal(pulled.status.ahead, 2);
    assert.equal((await git.status(fixture.repo)).behind, 0);

    write(fixture.repo, 'local-push.txt', 'local update\n');
    commit(fixture.repo, 'local push');
    await git.push(fixture.repo);
    assert.equal(runGit(fixture.remote, ['rev-parse', 'refs/heads/main']), runGit(fixture.repo, ['rev-parse', 'HEAD']));

    await git.createBranch(fixture.repo, 'feature/publish');
    write(fixture.repo, 'published.txt', 'published branch\n');
    commit(fixture.repo, 'publish feature');
    await git.push(fixture.repo, { remote: 'origin', branch: 'feature/publish', setUpstream: true });
    const status = await git.status(fixture.repo);
    assert.equal(status.upstream, 'origin/feature/publish');
    assert.equal(runGit(fixture.remote, ['rev-parse', 'refs/heads/feature/publish']), runGit(fixture.repo, ['rev-parse', 'HEAD']));
  });
});

test('force push requires confirmation and uses force-with-lease against the fetched remote tip', async () => {
  await withRepo(async (fixture) => {
    const peer = cloneRemote(fixture);
    write(peer, 'peer-only.txt', 'remote side\n');
    commit(peer, 'remote side commit');
    runGit(peer, ['push', 'origin', 'main']);

    write(fixture.repo, 'local-only.txt', 'local side\n');
    commit(fixture.repo, 'local side commit');
    await git.fetch(fixture.repo);
    const remoteTip = runGit(fixture.remote, ['rev-parse', 'refs/heads/main']);
    assert.equal((await git.status(fixture.repo)).ahead, 1);
    assert.equal((await git.status(fixture.repo)).behind, 1);

    await assert.rejects(git.push(fixture.repo, { force: true }), /confirmForce: true/);
    assert.equal(runGit(fixture.remote, ['rev-parse', 'refs/heads/main']), remoteTip);
    await git.push(fixture.repo, { force: true, confirmForce: true });
    assert.equal(runGit(fixture.remote, ['rev-parse', 'refs/heads/main']), runGit(fixture.repo, ['rev-parse', 'HEAD']));
    assert.equal((await git.status(fixture.repo)).behind, 0);
  });
});

test('conflicts parses real merge hunks and resolves ours, theirs, and manual edits before abort', async () => {
  await withRepo(async ({ repo }) => {
    const paths = ['ours.txt', 'theirs [literal].txt', 'manual.txt', 'leave-conflicted.txt'];
    for (const path of paths) write(repo, path, 'base value\n');
    commit(repo, 'add conflict fixtures');

    await git.createBranch(repo, 'feature/conflict');
    for (const path of paths) write(repo, path, `feature value for ${path}\n`);
    commit(repo, 'feature side changes');
    await git.checkout(repo, 'main');
    for (const path of paths) write(repo, path, `main value for ${path}\n`);
    commit(repo, 'main side changes');

    const merge = (() => {
      try {
        runGit(repo, ['merge', '--no-edit', 'feature/conflict']);
        return { code: 0 };
      } catch (error) {
        return { code: (error as { status?: number }).status ?? 1 };
      }
    })();
    assert.notEqual(merge.code, 0);

    const parsed = await git.conflicts(repo);
    assert.equal(parsed.operation, 'merge');
    assert.deepEqual(parsed.files.map((file) => file.path).sort(), [...paths].sort());
    const literal = parsed.files.find((file) => file.path === 'theirs [literal].txt');
    assert.ok(literal);
    assert.match(literal.content, /<<<<<<< HEAD/);
    assert.equal(literal.hunks.length, 1);
    assert.match(literal.hunks[0].ours, /main value/);
    assert.match(literal.hunks[0].theirs, /feature value/);

    await assert.rejects(git.resolveConflict(repo, 'manual.txt', 'manual'), /requires string content/);
    const ours = await git.resolveConflict(repo, 'ours.txt', 'ours');
    assert.equal(ours.remaining, 3);
    assert.equal(readFileSync(join(repo, 'ours.txt'), 'utf8'), 'main value for ours.txt\n');
    const theirs = await git.resolveConflict(repo, 'theirs [literal].txt', 'theirs');
    assert.equal(theirs.remaining, 2);
    assert.equal(readFileSync(join(repo, 'theirs [literal].txt'), 'utf8'), 'feature value for theirs [literal].txt\n');
    const manual = await git.resolveConflict(repo, 'manual.txt', 'manual', 'resolved by hand\n');
    assert.equal(manual.remaining, 1);
    assert.equal(readFileSync(join(repo, 'manual.txt'), 'utf8'), 'resolved by hand\n');
    assert.equal(manual.status.operation, 'merge');
    assert.equal(manual.status.hasConflicts, true);

    await assert.rejects(git.abortConflict(repo, false), /confirm: true/);
    const aborted = await git.abortConflict(repo, true);
    assert.equal(aborted.operation, null);
    assert.equal(aborted.hasConflicts, false);
    assert.deepEqual(aborted.files, []);
    for (const path of paths) assert.equal(readFileSync(join(repo, path), 'utf8'), `main value for ${path}\n`);
    await assert.rejects(git.abortConflict(repo, true), /No merge, rebase, or cherry-pick/);
  });
});

test('pull returns and aborts an actual merge conflict', async () => {
  await withRepo(async (fixture) => {
    const peer = cloneRemote(fixture);
    write(fixture.repo, 'README.md', 'local side\nstable line\n');
    commit(fixture.repo, 'local conflicting commit');
    write(peer, 'README.md', 'remote side\nstable line\n');
    commit(peer, 'remote conflicting commit');
    runGit(peer, ['push', 'origin', 'main']);

    const pulled = await git.pull(fixture.repo);
    assert.equal(pulled.ok, false);
    assert.equal(pulled.conflicts, true);
    assert.equal(pulled.status.operation, 'merge');
    assert.equal(pulled.status.hasConflicts, true);
    const parsed = await git.conflicts(fixture.repo);
    assert.equal(parsed.operation, 'merge');
    assert.deepEqual(parsed.files.map((file) => file.path), ['README.md']);

    const aborted = await git.abortConflict(fixture.repo, true);
    assert.equal(aborted.operation, null);
    assert.equal(aborted.hasConflicts, false);
    assert.equal(readFileSync(join(fixture.repo, 'README.md'), 'utf8'), 'local side\nstable line\n');
  });
});

test('pull rebase conflicts and cherry-pick conflicts report their operation and abort cleanly', async () => {
  await withRepo(async (fixture) => {
    const peer = cloneRemote(fixture);
    write(fixture.repo, 'README.md', 'local rebase side\nstable line\n');
    commit(fixture.repo, 'local rebase commit');
    write(peer, 'README.md', 'remote rebase side\nstable line\n');
    commit(peer, 'remote rebase commit');
    runGit(peer, ['push', 'origin', 'main']);

    const pulled = await git.pull(fixture.repo, { rebase: true });
    assert.equal(pulled.ok, false);
    assert.equal(pulled.conflicts, true);
    assert.equal(pulled.status.operation, 'rebase');
    assert.equal((await git.conflicts(fixture.repo)).operation, 'rebase');
    const rebaseAborted = await git.abortConflict(fixture.repo, true);
    assert.equal(rebaseAborted.operation, null);
    assert.equal(readFileSync(join(fixture.repo, 'README.md'), 'utf8'), 'local rebase side\nstable line\n');
  });

  await withRepo(async ({ repo }) => {
    await git.createBranch(repo, 'feature/cherry-pick-conflict');
    write(repo, 'README.md', 'cherry-pick side\nstable line\n');
    const pickedCommit = commit(repo, 'cherry-pick conflicting change');
    await git.checkout(repo, 'main');
    write(repo, 'README.md', 'main cherry-pick side\nstable line\n');
    commit(repo, 'main conflicting change');

    let cherryPickFailed = false;
    try {
      runGit(repo, ['cherry-pick', pickedCommit]);
    } catch {
      cherryPickFailed = true;
    }
    assert.equal(cherryPickFailed, true);
    const parsed = await git.conflicts(repo);
    assert.equal(parsed.operation, 'cherry-pick');
    assert.equal((await git.status(repo)).operation, 'cherry-pick');

    const aborted = await git.abortConflict(repo, true);
    assert.equal(aborted.operation, null);
    assert.equal(aborted.hasConflicts, false);
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'main cherry-pick side\nstable line\n');
  });
});

test('manual conflict resolution does not write through a hard link outside the repository', async () => {
  await withRepo(async ({ root, repo }) => {
    await git.createBranch(repo, 'feature/hardlink-conflict');
    write(repo, 'hardlink-conflict.txt', 'feature side\n');
    commit(repo, 'feature hardlink conflict');
    await git.checkout(repo, 'main');
    write(repo, 'hardlink-conflict.txt', 'main side\n');
    commit(repo, 'main hardlink conflict');
    try {
      runGit(repo, ['merge', '--no-edit', 'feature/hardlink-conflict']);
    } catch {
      // The expected merge conflict leaves the index unmerged.
    }

    const outside = join(root, 'protected-hardlink-target.txt');
    writeFileSync(outside, 'outside data must remain unchanged\n');
    rmSync(join(repo, 'hardlink-conflict.txt'));
    linkSync(outside, join(repo, 'hardlink-conflict.txt'));
    try {
      await git.resolveConflict(repo, 'hardlink-conflict.txt', 'manual', 'resolved safely\n');
    } catch {
      // Rejecting a linked conflict file is safe; replacing it without following the link is also safe.
    }
    assert.equal(readFileSync(outside, 'utf8'), 'outside data must remain unchanged\n');
  });
});

test('worktrees support task slugs, custom branches and paths, dirty status, and committed comparison', async () => {
  await withRepo(async ({ root, repo }) => {
    const task = await git.addWorktree(repo, { taskSlug: 'TASK 42 / check', baseRef: 'main' });
    assert.equal(task.branch, 'uniharn/TASK-42-check');
    assert.equal(task.detached, false);
    assert.equal(task.dirtyCount, 0);
    assert.equal(task.hasUncommittedChanges, false);
    assert.equal(existsSync(task.path), true);

    const customPath = join(root, 'custom worktree path');
    const custom = await git.addWorktree(repo, {
      path: customPath,
      newBranch: 'feature/custom-branch',
      baseRef: 'main',
    });
    assert.equal(custom.path, customPath);
    assert.equal(custom.branch, 'feature/custom-branch');

    write(task.path, 'task-result.txt', 'committed from task worktree\n');
    commit(task.path, 'task result');
    write(task.path, 'README.md', 'uncommitted task edit\nstable line\n');

    const listed = await git.listWorktrees(repo);
    const main = listed.find((worktree) => worktree.path === repo);
    const listedTask = listed.find((worktree) => worktree.path === task.path);
    const listedCustom = listed.find((worktree) => worktree.path === custom.path);
    assert.equal(main?.isMain, true);
    assert.equal(main?.hasUncommittedChanges, false);
    assert.equal(listedTask?.dirtyCount, 1);
    assert.equal(listedTask?.hasUncommittedChanges, true);
    assert.equal(listedCustom?.dirtyCount, 0);

    const comparison = await git.compareWorktree(repo, task.path, 'main');
    assert.equal(comparison.worktreePath, task.path);
    assert.equal(comparison.branch, 'uniharn/TASK-42-check');
    assert.equal(comparison.baseBranch, 'main');
    assert.equal(comparison.ahead, 1);
    assert.equal(comparison.behind, 0);
    assert.ok(comparison.uncommittedFiles.some((file) => file.path === 'README.md'));
    assert.ok(comparison.committedFiles.some((file) => file.path === 'task-result.txt'));
    assert.match(comparison.diff, /committed from task worktree/);
    assert.equal(comparison.truncated, false);
  });
});

test('worktree merge previews and confirms clean fast-forward merges, reports conflicts, and refuses dirty trees', async () => {
  await withRepo(async ({ root, repo }) => {
    const cleanSource = await git.addWorktree(repo, { newBranch: 'feature/clean-merge', baseRef: 'main' });
    write(cleanSource.path, 'clean-merge.txt', 'clean merge content\n');
    commit(cleanSource.path, 'clean worktree change');

    const preview = await git.mergeWorktree(repo, cleanSource.path);
    assert.equal(preview.preview, true);
    assert.equal(preview.canFastForward, true);
    assert.equal(preview.hasConflicts, false);
    assert.deepEqual(preview.conflictFiles, []);
    assert.equal(preview.ahead, 1);
    assert.equal(preview.branch, 'feature/clean-merge');
    assert.equal(preview.targetBranch, 'main');

    const merged = await git.mergeWorktree(repo, cleanSource.path, { confirm: true });
    assert.equal(merged.merged, true);
    assert.equal(merged.conflicts, false);
    assert.deepEqual(merged.conflictFiles, []);
    assert.equal(merged.status.branch, 'main');
    assert.equal(existsSync(join(repo, 'clean-merge.txt')), true);

    const conflictSource = await git.addWorktree(repo, { newBranch: 'feature/conflicting-merge', baseRef: 'main' });
    write(conflictSource.path, 'README.md', 'source side\nstable line\n');
    commit(conflictSource.path, 'source conflict change');
    write(repo, 'README.md', 'target side\nstable line\n');
    commit(repo, 'target conflict change');

    const conflictPreview = await git.mergeWorktree(repo, conflictSource.path);
    assert.equal(conflictPreview.preview, true);
    assert.equal(conflictPreview.hasConflicts, true);
    assert.ok(conflictPreview.conflictFiles.includes('README.md'));

    const conflictMerge = await git.mergeWorktree(repo, conflictSource.path, { confirm: true });
    assert.equal(conflictMerge.merged, false);
    assert.equal(conflictMerge.conflicts, true);
    assert.ok(conflictMerge.conflictFiles.includes('README.md'));
    assert.equal(conflictMerge.status.operation, 'merge');
    await git.abortConflict(repo, true);

    const dirtySource = await git.addWorktree(repo, { newBranch: 'feature/dirty-source', baseRef: 'main' });
    write(dirtySource.path, 'dirty-source.txt', 'not committed\n');
    await assert.rejects(git.mergeWorktree(repo, dirtySource.path), /Source worktree has uncommitted changes/);
    rmSync(join(dirtySource.path, 'dirty-source.txt'));

    write(repo, 'dirty-target.txt', 'not committed\n');
    await assert.rejects(git.mergeWorktree(repo, dirtySource.path), /Target worktree has uncommitted changes/);
    await git.discard(repo, ['dirty-target.txt'], true);
  });
});

test('worktree removal refuses dirty trees without both guards and permits confirmed force or clean removal', async () => {
  await withRepo(async ({ repo }) => {
    const dirty = await git.addWorktree(repo, { newBranch: 'feature/dirty-remove', baseRef: 'main' });
    write(dirty.path, 'dirty.txt', 'uncommitted\n');
    await assert.rejects(git.removeWorktree(repo, dirty.path), /force: true and confirmDirty: true/);
    await assert.rejects(git.removeWorktree(repo, dirty.path, { force: true }), /force: true and confirmDirty: true/);
    assert.equal(existsSync(dirty.path), true);

    const forced = await git.removeWorktree(repo, dirty.path, { force: true, confirmDirty: true });
    assert.equal(forced, undefined);
    assert.equal(existsSync(dirty.path), false);
    assert.ok(!(await git.listWorktrees(repo)).some((worktree) => worktree.path === dirty.path));

    await assert.rejects(git.removeWorktree(repo, repo), /main worktree/);
    const clean = await git.addWorktree(repo, { newBranch: 'feature/clean-remove', baseRef: 'main' });
    const alias = join(repo, 'worktree alias');
    symlinkSync(clean.path, alias, 'dir');
    const removed = await git.removeWorktree(repo, alias, { deleteBranch: true });
    assert.equal(removed, undefined);
    assert.equal(existsSync(clean.path), false);
    assert.ok(!(await git.branches(repo)).some((branch) => branch.name === 'feature/clean-remove'));
  });
});

test('worktrees expose locked metadata and prune a removed worktree directory', async () => {
  await withRepo(async ({ repo }) => {
    const worktree = await git.addWorktree(repo, { newBranch: 'feature/prune-me', baseRef: 'main' });
    runGit(repo, ['worktree', 'lock', '--reason', 'test lock', worktree.path]);
    const locked = (await git.listWorktrees(repo)).find((entry) => entry.path === worktree.path);
    assert.equal(locked?.locked, true);

    runGit(repo, ['worktree', 'unlock', worktree.path]);
    rmSync(worktree.path, { recursive: true, force: true });
    const beforePrune = (await git.listWorktrees(repo)).find((entry) => entry.path === worktree.path);
    assert.equal(beforePrune?.prunable, true);

    const afterPrune = await git.pruneWorktrees(repo);
    assert.ok(!(afterPrune).some((entry) => entry.path === worktree.path));
  });
});

test('diff marks patches over 4 MiB as truncated', async () => {
  await withRepo(async ({ repo }) => {
    const contents = `${'x'.repeat(4 * 1024 * 1024 + 1024)}\n`;
    write(repo, 'large-untracked.txt', contents);
    const result = await git.diff(repo);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.diff) <= 4 * 1024 * 1024);
    assert.match(result.diff, /large-untracked\.txt/);
  });
});

test('unstaging the new path of a staged rename also unstages the old path', async () => {
  await withRepo(async ({ repo }) => {
    runGit(repo, ['mv', 'README.md', 'DOC.md']);
    assert.ok((await git.status(repo)).files.some((f) => f.status === 'renamed' && f.staged));
    const st = await git.unstage(repo, ['DOC.md']);
    assert.ok(!st.files.some((f) => f.staged));
    assert.equal(runGit(repo, ['diff', '--cached', '--name-only']), '');
  });
});

test('force push only updates the current branch even with push.default=matching', async () => {
  await withRepo(async ({ repo, remote }) => {
    runGit(repo, ['config', 'push.default', 'matching']);
    await git.createBranch(repo, 'side', { checkout: true });
    write(repo, 'side.txt', 'side\n');
    commit(repo, 'side commit');
    runGit(repo, ['push', 'origin', 'side']);
    const remoteSide = runGit(remote, ['rev-parse', 'refs/heads/side']);
    runGit(repo, ['reset', '--hard', 'HEAD~1']);
    await git.checkout(repo, 'main');
    write(repo, 'main.txt', 'main\n');
    commit(repo, 'main commit');
    await git.push(repo, { force: true, confirmForce: true });
    assert.equal(runGit(remote, ['rev-parse', 'refs/heads/main']), runGit(repo, ['rev-parse', 'HEAD']));
    assert.equal(runGit(remote, ['rev-parse', 'refs/heads/side']), remoteSide);
  });
});

test('binary conflicts are reported as binary and refuse manual text resolution', async () => {
  await withRepo(async ({ repo }) => {
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0xff]));
    commit(repo, 'add binary');
    await git.createBranch(repo, 'feature/bin', { checkout: true });
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 9, 9, 0xfe]));
    commit(repo, 'feature binary');
    await git.checkout(repo, 'main');
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 7, 7, 0xfd]));
    commit(repo, 'main binary');
    assert.throws(() => runGit(repo, ['merge', '--no-edit', 'feature/bin']));
    const parsed = await git.conflicts(repo);
    assert.equal(parsed.files[0]?.binary, true);
    assert.equal(parsed.files[0]?.content, '');
    await assert.rejects(git.resolveConflict(repo, 'blob.bin', 'manual', 'text'), /Binary files/);
    assert.deepEqual([...readFileSync(join(repo, 'blob.bin'))], [0, 7, 7, 0xfd]);
    await git.resolveConflict(repo, 'blob.bin', 'theirs');
    assert.deepEqual([...readFileSync(join(repo, 'blob.bin'))], [0, 9, 9, 0xfe]);
  });
});

test('confirmed dirty worktree removal keeps a branch with unmerged commits', async () => {
  await withRepo(async ({ repo }) => {
    const wt = await git.addWorktree(repo, { newBranch: 'feature/unmerged', baseRef: 'main' });
    write(wt.path, 'work.txt', 'committed\n');
    commit(wt.path, 'unmerged work');
    write(wt.path, 'dirty.txt', 'uncommitted\n');
    await assert.rejects(
      git.removeWorktree(repo, wt.path, { force: true, confirmDirty: true, deleteBranch: true }),
      /Branch retained/,
    );
    assert.equal(existsSync(wt.path), false);
    assert.ok((await git.branches(repo)).some((branch) => branch.name === 'feature/unmerged'));
  });
});

test('force push targets a differently named upstream instead of the same-named branch', async () => {
  await withRepo(async ({ repo, remote }) => {
    runGit(repo, ['config', 'push.default', 'upstream']);
    runGit(repo, ['checkout', '-b', 'local-name']);
    write(repo, 'x.txt', 'x\n');
    commit(repo, 'x');
    runGit(repo, ['push', 'origin', 'local-name:remote-name', 'local-name:local-name']);
    runGit(repo, ['branch', '--set-upstream-to=origin/remote-name']);
    const sameName = runGit(remote, ['rev-parse', 'refs/heads/local-name']);
    runGit(repo, ['commit', '--amend', '-m', 'x amended']);
    await git.push(repo, { force: true, confirmForce: true });
    assert.equal(runGit(remote, ['rev-parse', 'refs/heads/remote-name']), runGit(repo, ['rev-parse', 'HEAD']));
    assert.equal(runGit(remote, ['rev-parse', 'refs/heads/local-name']), sameName);
  });
});

test('conflict text keeps a UTF-8 BOM and unstaging a copy keeps its source staged', async () => {
  await withRepo(async ({ repo }) => {
    write(repo, 'bom.txt', '\uFEFFheader\none\ntwo\nbase\n');
    commit(repo, 'bom');
    await git.createBranch(repo, 'feature/bom', { checkout: true });
    write(repo, 'bom.txt', '\uFEFFheader\none\ntwo\nfeature\n');
    commit(repo, 'feature bom');
    await git.checkout(repo, 'main');
    write(repo, 'bom.txt', '\uFEFFheader\none\ntwo\nmain\n');
    commit(repo, 'main bom');
    assert.throws(() => runGit(repo, ['merge', '--no-edit', 'feature/bom']));
    const parsed = await git.conflicts(repo);
    assert.ok(parsed.files[0]?.content.startsWith('\uFEFF'));
    await git.resolveConflict(repo, 'bom.txt', 'manual', parsed.files[0]!.content.replace(/<<<<<<<[^]*>>>>>>> [^\n]*\n/, 'merged\n'));
    assert.deepEqual([...readFileSync(join(repo, 'bom.txt')).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    runGit(repo, ['commit', '--no-edit']);

    runGit(repo, ['config', 'status.renames', 'copies']);
    write(repo, 'README.md', 'base line\nstable line\nsource edit\n');
    write(repo, 'COPY.md', 'base line\nstable line\n');
    runGit(repo, ['add', '-A']);
    await git.unstage(repo, ['COPY.md']);
    assert.equal(runGit(repo, ['diff', '--cached', '--name-only']), 'README.md');
  });
});
