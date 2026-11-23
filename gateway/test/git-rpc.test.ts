import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRpc } from '../src/git-rpc.js';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const run = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

test('git RPC handler routes git.* requests, enforces confirmations, and ignores other request types', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uniharn-git-rpc-')));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  try {
    run(root, ['init', '--initial-branch=main', repo]);
    run(repo, ['config', 'user.name', 'RPC Test']);
    run(repo, ['config', 'user.email', 'rpc-test@example.invalid']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    const rpc = createGitRpc(data);

    assert.equal(rpc.handle('session.create', {}), undefined);
    assert.equal(rpc.handle('git.toString', {}), undefined);

    await rpc.handle('git.stage', { cwd: repo, all: true });
    const committed = await rpc.handle('git.commit', { cwd: repo, message: 'first' });
    assert.equal(committed.subject, 'first');
    assert.equal(committed.status.files.length, 0);

    writeFileSync(join(repo, 'a.txt'), 'two\n');
    await assert.rejects(rpc.handle('git.discard', { cwd: repo, paths: ['a.txt'] })!, /confirm/);
    await assert.rejects(rpc.handle('git.push', { cwd: repo, force: true })!, /confirm/i);
    const discarded = await rpc.handle('git.discard', { cwd: repo, paths: ['a.txt'], confirm: true });
    assert.equal(discarded.files.length, 0);

    const { commits } = await rpc.handle('git.log', { cwd: repo });
    assert.equal(commits[0].subject, 'first');

    const wt = await rpc.handle('git.worktreeAdd', { cwd: repo, taskSlug: 'agent one' });
    assert.equal(wt.branch, 'uniharn/agent-one');
    writeFileSync(join(wt.path, 'b.txt'), 'dirty\n');
    await assert.rejects(rpc.handle('git.worktreeRemove', { cwd: repo, worktreePath: wt.path })!, /uncommitted/);
    assert.equal(existsSync(join(wt.path, 'b.txt')), true);
    assert.deepEqual(await rpc.handle('git.worktreeRemove', { cwd: repo, worktreePath: wt.path, force: true, confirmDirty: true }), { removed: true });

    const linked = await rpc.handle('git.sessionPrLink', { sessionId: 'devin:s1', cwd: repo, number: 7, url: 'https://github.com/o/r/pull/7', title: 'PR' });
    assert.equal(linked.link.number, 7);
    assert.equal((await createGitRpc(data).handle('git.sessionPrGet', { sessionId: 'devin:s1' })).link.number, 7);
    assert.deepEqual(await rpc.handle('git.sessionPrUnlink', { sessionId: 'devin:s1' }), { removed: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git RPC handler reports git.status results to onStatus for conflict notifications', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uniharn-git-rpc-')));
  const repo = join(root, 'repo');
  try {
    run(root, ['init', '--initial-branch=main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    const seen: Array<{ cwd: string; files: number }> = [];
    const rpc = createGitRpc(join(root, 'data'), { onStatus: (cwd, st) => seen.push({ cwd, files: st.files.length }) });
    const st = await rpc.handle('git.status', { cwd: repo });
    assert.equal(st.isRepo, true);
    assert.deepEqual(seen, [{ cwd: repo, files: 1 }]);
    await rpc.handle('git.status', { cwd: root });
    assert.equal(seen.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git RPC root checks hide linked worktrees outside the allowed roots and guard merge targets', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uniharn-git-rpc-roots-')));
  const repo = join(root, 'repo');
  try {
    run(root, ['init', '--initial-branch=main', repo]);
    run(repo, ['config', 'user.name', 'RPC Test']);
    run(repo, ['config', 'user.email', 'rpc-test@example.invalid']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-m', 'first']);
    const outside = join(root, 'outside-wt');
    run(repo, ['worktree', 'add', '-b', 'outside', outside]);
    const inside = join(repo, 'wt');
    run(repo, ['worktree', 'add', '-b', 'inside', inside]);
    const checkPath = (path: string) => {
      if (path !== repo && !path.startsWith(repo + '/')) throw new Error('Path is outside allowed roots');
      return path;
    };
    const rpc = createGitRpc(join(root, 'data'), { checkPath });
    const { worktrees } = await rpc.handle('git.worktrees', { cwd: repo });
    assert.deepEqual(worktrees.map((w: { path: string }) => w.path).sort(), [repo, inside].sort());
    await assert.rejects(rpc.handle('git.worktreeAdd', { cwd: repo, taskSlug: 'x' })!, /outside allowed roots/);
    await assert.rejects(rpc.handle('git.worktreeMerge', { cwd: repo, worktreePath: inside, targetBranch: 'outside' })!, /outside allowed roots/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git RPC refuses a recreated session folder instead of reaching the enclosing repository', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uniharn-git-rpc-')));
  const repo = join(root, 'repo');
  try {
    run(root, ['init', '--initial-branch=main', repo]);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    const gone = join(repo, 'worktree');
    execFileSync('mkdir', [gone]);
    const rpc = createGitRpc(join(root, 'data'), { isRecreated: (p) => p === gone });
    await assert.rejects(rpc.handle('git.status', { cwd: gone }), /recreated empty/);
    await assert.rejects(rpc.handle('git.discard', { cwd: gone, all: true, confirm: true }), /recreated empty/);
    assert.ok(existsSync(join(repo, 'a.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
