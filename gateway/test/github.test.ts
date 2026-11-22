import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPr, detectGhStatus, diffPr, listPrs, SessionPrStore, viewPr } from '../src/github.js';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

const summary = {
  number: 42,
  title: 'Fix the gateway',
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/acme/project/pull/42',
  headRefName: 'feature/fix-gateway',
  baseRefName: 'main',
  author: { login: 'codex' },
  createdAt: '2026-10-01T12:00:00Z',
  updatedAt: '2026-10-02T12:00:00Z',
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  reviewDecision: 'REVIEW_REQUIRED',
  mergeable: 'MERGEABLE',
};

const view = {
  ...summary,
  body: 'Details',
  statusCheckRollup: [{ name: 'CI', conclusion: 'SUCCESS' }],
  files: [{ path: 'gateway/src/github.ts', additions: 12, deletions: 3 }],
};

const fakeGhScript = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.GH_PROMPT_DISABLED !== '1') { process.stderr.write('prompt env missing'); process.exit(9); }
fs.appendFileSync(process.env.GH_TEST_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.GH_TEST_MODE || 'authenticated';
if (args[0] === '--version') {
  if (mode === 'missing') process.exit(127);
  process.stdout.write('gh version 2.test');
} else if (args[0] === 'auth' && args[1] === 'status') {
  if (mode === 'unauthenticated') { process.stderr.write('not logged in'); process.exit(1); }
  process.stdout.write('Logged in to github.com');
} else if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(process.env.GH_TEST_LIST_JSON || '[]');
} else if (args[0] === 'pr' && args[1] === 'view') {
  if (process.env.GH_TEST_VIEW_FAIL === '1') { process.stderr.write('readback failed'); process.exit(1); }
  process.stdout.write(process.env.GH_TEST_VIEW_JSON || '{}');
} else if (args[0] === 'pr' && args[1] === 'diff') {
  if (process.env.GH_TEST_DIFF_STDERR_BYTES) process.stderr.write(Buffer.alloc(Number(process.env.GH_TEST_DIFF_STDERR_BYTES), 101));
  process.stdout.write(Buffer.alloc(Number(process.env.GH_TEST_DIFF_BYTES || 0), 120));
} else if (args[0] === 'pr' && args[1] === 'create') {
  process.stdout.write(process.env.GH_TEST_CREATE_URL || 'https://github.com/acme/project/pull/42\\n');
} else {
  process.stderr.write('unexpected gh invocation: ' + JSON.stringify(args));
  process.exit(2);
}
`;

function setupGhFixture(mode = 'authenticated') {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-gh-test-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const script = join(binDir, 'gh');
  const log = join(dir, 'gh-args.jsonl');
  writeFileSync(script, fakeGhScript);
  chmodSync(script, 0o755);
  const old = {
    path: process.env.PATH,
    mode: process.env.GH_TEST_MODE,
    log: process.env.GH_TEST_LOG,
    list: process.env.GH_TEST_LIST_JSON,
    view: process.env.GH_TEST_VIEW_JSON,
    diffBytes: process.env.GH_TEST_DIFF_BYTES,
    diffStderrBytes: process.env.GH_TEST_DIFF_STDERR_BYTES,
    createUrl: process.env.GH_TEST_CREATE_URL,
    viewFail: process.env.GH_TEST_VIEW_FAIL,
  };
  process.env.PATH = `${binDir}${delimiter}${old.path ?? ''}`;
  process.env.GH_TEST_MODE = mode;
  process.env.GH_TEST_LOG = log;
  process.env.GH_TEST_LIST_JSON = JSON.stringify([summary]);
  process.env.GH_TEST_VIEW_JSON = JSON.stringify(view);
  process.env.GH_TEST_DIFF_BYTES = '0';
  delete process.env.GH_TEST_DIFF_STDERR_BYTES;
  process.env.GH_TEST_CREATE_URL = 'https://github.com/acme/project/pull/42\n';
  delete process.env.GH_TEST_VIEW_FAIL;
  return {
    dir,
    log,
    restore() {
      for (const [key, value] of Object.entries({
        PATH: old.path,
        GH_TEST_MODE: old.mode,
        GH_TEST_LOG: old.log,
        GH_TEST_LIST_JSON: old.list,
        GH_TEST_VIEW_JSON: old.view,
        GH_TEST_DIFF_BYTES: old.diffBytes,
        GH_TEST_DIFF_STDERR_BYTES: old.diffStderrBytes,
        GH_TEST_CREATE_URL: old.createUrl,
        GH_TEST_VIEW_FAIL: old.viewFail,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
    calls(): string[][] {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

let repoNumber = 0;
async function makeRepo(dir: string, remotes: Array<[string, string]>): Promise<string> {
  const cwd = join(dir, `repo-${++repoNumber}`);
  mkdirSync(cwd);
  await execFileAsync('git', ['init', '-q', cwd]);
  for (const [name, url] of remotes) await execFileAsync('git', ['-C', cwd, 'remote', 'add', name, url]);
  return cwd;
}

test('detectGhStatus prefers a GitHub origin, redacts URL credentials, and reports unauthenticated gh', async () => {
  const fixture = setupGhFixture('unauthenticated');
  try {
    const cwd = await makeRepo(fixture.dir, [
      ['origin', 'https://user:super-secret@github.com/acme/project.git?token=hidden'],
      ['mirror', 'git@github.com:other/repository.git'],
    ]);
    const result = await detectGhStatus(cwd);
    assert.deepEqual(result, {
      ghInstalled: true,
      authenticated: false,
      isGitHubRepo: true,
      repoSlug: 'acme/project',
      remoteUrl: 'https://***@github.com/acme/project.git',
      error: 'GitHub CLI is not authenticated',
    });
    assert.equal(JSON.stringify(result).includes('super-secret'), false);
    assert.equal(JSON.stringify(result).includes('hidden'), false);
    assert.ok(fixture.calls().some((args) => args.join(' ') === 'auth status --hostname github.com'));
  } finally {
    fixture.restore();
  }
});

test('detectGhStatus falls back to another GitHub remote and handles non-GitHub repositories', async () => {
  const fixture = setupGhFixture();
  try {
    const withMirror = await makeRepo(fixture.dir, [
      ['origin', 'https://gitlab.com/acme/project.git'],
      ['mirror', 'git@github.com:acme/project.git'],
    ]);
    const status = await detectGhStatus(withMirror);
    assert.equal(status.authenticated, true);
    assert.equal(status.repoSlug, 'acme/project');
    assert.equal(status.remoteUrl, 'git@github.com:acme/project.git');

    const nonGithub = await makeRepo(fixture.dir, [['origin', 'https://gitlab.com/acme/project.git']]);
    const nonGithubStatus = await detectGhStatus(nonGithub);
    assert.equal(nonGithubStatus.isGitHubRepo, false);
    assert.equal(nonGithubStatus.repoSlug, null);
    assert.equal(nonGithubStatus.remoteUrl, null);
    assert.equal(nonGithubStatus.error, undefined);

    const unsupported = await makeRepo(fixture.dir, [['origin', 'ftp://github.com/acme/project.git']]);
    assert.equal((await detectGhStatus(unsupported)).isGitHubRepo, false);

    const missingGh = setupGhFixture('missing');
    try {
      const githubRepo = await makeRepo(missingGh.dir, [['origin', 'git@github.com:acme/project.git']]);
      const missingStatus = await detectGhStatus(githubRepo);
      assert.equal(missingStatus.ghInstalled, false);
      assert.equal(missingStatus.authenticated, false);
      assert.equal(missingStatus.isGitHubRepo, true);
      assert.equal(missingStatus.repoSlug, 'acme/project');
      assert.match(missingStatus.error ?? '', /not installed/i);
    } finally {
      missingGh.restore();
    }
  } finally {
    fixture.restore();
  }
});

test('listPrs and viewPr return GitHub JSON fields and pass options as individual arguments', async () => {
  const fixture = setupGhFixture();
  try {
    const cwd = await makeRepo(fixture.dir, [['origin', 'git@github.com:acme/project.git']]);
    const prs = await listPrs(cwd, { state: 'merged', limit: 17 });
    assert.deepEqual(prs, [summary]);
    assert.deepEqual(await viewPr(cwd, 42), view);

    const calls = fixture.calls();
    assert.ok(calls.some((args) => args.includes('pr') && args.includes('list') && args.includes('--repo=github.com/acme/project') && args.includes('--state=merged') && args.includes('--limit=17')));
    assert.ok(calls.some((args) => args.includes('pr') && args.includes('view') && args.includes('42') && args.includes('--repo=github.com/acme/project') && args.some((arg) => arg.includes('statusCheckRollup') && arg.includes('files'))));
  } finally {
    fixture.restore();
  }
});

test('diffPr returns a UTF-8 byte-bounded diff and marks truncation', async () => {
  const fixture = setupGhFixture();
  try {
    const cwd = await makeRepo(fixture.dir, [['origin', 'git@github.com:acme/project.git']]);
    process.env.GH_TEST_DIFF_BYTES = String(MAX_DIFF_BYTES + 100);
    const result = await diffPr(cwd, 42);
    assert.equal(Buffer.byteLength(result.diff, 'utf8'), MAX_DIFF_BYTES);
    assert.equal(result.truncated, true);
    assert.ok(fixture.calls().some((args) => args.includes('--repo=github.com/acme/project')));

    process.env.GH_TEST_DIFF_BYTES = '32';
    process.env.GH_TEST_DIFF_STDERR_BYTES = String(MAX_DIFF_BYTES + 100);
    await assert.rejects(diffPr(cwd, 42), /stderr exceeded/i);
  } finally {
    fixture.restore();
  }
});

test('createPr sends title/body as safe arguments and returns the structured created pull request', async () => {
  const fixture = setupGhFixture();
  try {
    const cwd = await makeRepo(fixture.dir, [['origin', 'https://github.com/acme/project.git']]);
    const body = 'line one\n$(touch should-not-run); --draft';
    const created = await createPr(cwd, {
      title: 'A title with spaces',
      body,
      base: 'release',
      head: 'feature/pr',
      draft: true,
    });
    assert.deepEqual(created, {
      url: summary.url,
      number: 42,
      title: summary.title,
      state: summary.state,
      isDraft: summary.isDraft,
      headRefName: summary.headRefName,
      baseRefName: summary.baseRefName,
    });
    const createArgs = fixture.calls().find((args) => args[0] === 'pr' && args[1] === 'create');
    assert.ok(createArgs);
    assert.ok(createArgs.includes('--repo=github.com/acme/project'));
    assert.ok(createArgs.includes('--title=A title with spaces'));
    assert.ok(createArgs.includes(`--body=${body}`));
    assert.ok(createArgs.includes('--base=release'));
    assert.ok(createArgs.includes('--head=feature/pr'));
    assert.ok(createArgs.includes('--draft'));

    await createPr(cwd, { title: 'Empty body' });
    const emptyBodyArgs = fixture.calls().find((args) => args[0] === 'pr' && args[1] === 'create' && args.includes('--title=Empty body'));
    assert.ok(emptyBodyArgs?.includes('--body='));
    const readbackArgs = fixture.calls().find((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === summary.url);
    assert.ok(readbackArgs?.includes('--repo=github.com/acme/project'));
  } finally {
    fixture.restore();
  }
});

test('PR operations reject repositories without a supported GitHub remote', async () => {
  const fixture = setupGhFixture();
  try {
    const cwd = await makeRepo(fixture.dir, []);
    await assert.rejects(listPrs(cwd), /Not a GitHub repository/);
    await assert.rejects(createPr(cwd, { title: 'No remote' }), /Not a GitHub repository/);
    assert.deepEqual(fixture.calls(), []);
  } finally {
    fixture.restore();
  }
});

test('createPr includes the created URL when readback fails', async () => {
  const fixture = setupGhFixture();
  try {
    const cwd = await makeRepo(fixture.dir, [['origin', 'git@github.com:acme/project.git']]);
    process.env.GH_TEST_VIEW_FAIL = '1';
    await assert.rejects(
      createPr(cwd, { title: 'Created' }),
      (error: unknown) => error instanceof Error && error.message.includes(summary.url) && error.message.includes('readback failed'),
    );
    assert.ok(fixture.calls().some((args) => args.includes(summary.url) && args.includes('--repo=github.com/acme/project')));
  } finally {
    fixture.restore();
  }
});

test('SessionPrStore persists, replaces, lists, and unlinks session pull requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-session-pr-test-'));
  try {
    const first = new SessionPrStore(dir);
    const linked = first.link('devin:session-1', {
      cwd: '/tmp/project',
      number: 42,
      url: 'https://github.com/acme/project/pull/42',
      title: 'Fix gateway',
      state: 'OPEN',
      headRefName: 'feature/fix',
      baseRefName: 'main',
      linkedAt: 1000,
    });
    assert.deepEqual(linked, {
      sessionId: 'devin:session-1',
      cwd: '/tmp/project',
      number: 42,
      url: 'https://github.com/acme/project/pull/42',
      title: 'Fix gateway',
      state: 'OPEN',
      headRefName: 'feature/fix',
      baseRefName: 'main',
      linkedAt: 1000,
    });

    const second = new SessionPrStore(dir);
    assert.deepEqual(second.get('devin:session-1'), linked);
    assert.deepEqual(second.list(), [linked]);
    assert.equal(readFileSync(join(dir, 'session-prs.json'), 'utf8').endsWith('\n'), true);

    const replaced = second.link('devin:session-1', {
      cwd: '/tmp/project',
      number: 43,
      url: 'https://github.com/acme/project/pull/43',
      title: 'Follow-up',
      linkedAt: 2000,
    });
    assert.equal(replaced.number, 43);
    assert.equal(second.unlink('devin:session-1'), true);
    assert.equal(second.unlink('devin:session-1'), false);
    assert.deepEqual(new SessionPrStore(dir).list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionPrStore keeps its map unchanged if the atomic disk replacement fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-session-pr-atomic-test-'));
  try {
    const store = new SessionPrStore(dir);
    const original = store.link('session-1', {
      cwd: '/tmp/project', number: 42, url: 'https://github.com/acme/project/pull/42', title: 'Original', linkedAt: 1,
    });
    const file = join(dir, 'session-prs.json');
    const backup = join(dir, 'saved.json');
    renameSync(file, backup);
    mkdirSync(file);
    assert.throws(() => store.link('session-2', {
      cwd: '/tmp/project', number: 43, url: 'https://github.com/acme/project/pull/43', title: 'Cannot persist', linkedAt: 2,
    }));
    assert.deepEqual(store.list(), [original]);
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
