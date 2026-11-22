import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderSystemdUnit } from '../src/diagnostics.js';
import { assertAllowedPath, isPathWithinRoots, isPublicBindHost, isRunningAsRoot, RateLimiter, redactSecrets } from '../src/security.js';

test('redactSecrets masks device credentials, URL parameters, and literal secrets', () => {
  const text = 'auth=bEaReR abc123 token=xyz http://localhost/#token=abc&code=ABCD-EFGH uhd_ab-12_C master.+[token]';
  assert.equal(
    redactSecrets(text, ['master.+[token]', '']),
    'auth=bEaReR [REDACTED] token=[REDACTED] http://localhost/#token=[REDACTED]&code=[REDACTED] [REDACTED] [REDACTED]',
  );
  assert.equal(redactSecrets('token="contains spaces" code=\'one time\' status=ok'), 'token=[REDACTED] code=[REDACTED] status=ok');
  assert.equal(redactSecrets('token=first&second', ['first&second']), 'token=[REDACTED]');
  assert.equal(redactSecrets('token=firstlonger', ['first']), 'token=[REDACTED]');
  assert.equal(redactSecrets('hello world', ['absent']), 'hello world');
});

test('RateLimiter uses a sliding window and isolates keys', () => {
  let now = 1000;
  const limiter = new RateLimiter(3, 100, () => now);
  limiter.recordFailure('a');
  now += 20;
  limiter.recordFailure('a');
  now += 20;
  assert.equal(limiter.check('a'), true);
  limiter.recordFailure('a');
  assert.equal(limiter.check('a'), false);
  assert.equal(limiter.retryAfterMs('a'), 60);
  assert.equal(limiter.check('b'), true);
  now += 59;
  limiter.recordFailure('a');
  assert.equal(limiter.retryAfterMs('a'), 1);
  now += 1;
  assert.equal(limiter.check('a'), true);
  limiter.recordFailure('a');
  assert.equal(limiter.retryAfterMs('a'), 20);
  limiter.reset('a');
  assert.equal(limiter.retryAfterMs('a'), 0);
});

test('security flags identify wildcard hosts and the current process identity', () => {
  for (const host of ['0.0.0.0', '::', '*', '']) assert.equal(isPublicBindHost(host), true);
  for (const host of ['127.0.0.1', 'localhost', '::1', '100.64.0.1']) assert.equal(isPublicBindHost(host), false);
  assert.equal(isRunningAsRoot(), process.getuid?.() === 0);
});

test('strict roots check directory boundaries, root symlinks, and missing descendants', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uniharn-roots-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const allowed = join(dir, 'repo');
  const outside = join(dir, 'repo-sibling');
  const alias = join(dir, 'alias');
  mkdirSync(allowed);
  mkdirSync(outside);
  mkdirSync(join(allowed, 'nested'));
  symlinkSync(allowed, alias, 'dir');
  symlinkSync(outside, join(allowed, 'escape'), 'dir');
  symlinkSync(join(allowed, 'nested'), join(allowed, 'inside'), 'dir');
  symlinkSync(join(outside, 'missing'), join(allowed, 'dangling'), 'dir');

  assert.equal(isPathWithinRoots(allowed, [alias]), true);
  assert.equal(isPathWithinRoots(join(alias, 'new', 'files'), [allowed]), true);
  assert.equal(assertAllowedPath(join(allowed, 'inside', 'future'), [alias], true), join(allowed, 'nested', 'future'));
  assert.equal(isPathWithinRoots(join(dir, 'future', 'child'), [join(dir, 'future')]), true);
  for (const path of [outside, join(allowed, 'escape'), join(allowed, 'escape', 'future'), join(allowed, 'dangling', 'future')]) {
    assert.equal(isPathWithinRoots(path, [allowed]), false);
    assert.throws(() => assertAllowedPath(path, [allowed], true), { message: 'Path is outside allowed roots' });
    assert.equal(assertAllowedPath(path, [allowed], false), path);
  }
  assert.equal(isPathWithinRoots(allowed, []), false);
});

test('renderSystemdUnit quotes arguments and preserves a literal percent and dollar sign', () => {
  const unit = renderSystemdUnit({
    nodePath: '/usr/bin/node', entryPath: '/home/me/gateway dist/index.js', workingDirectory: '/home/me',
    args: ['--strict-roots', '--roots', '/home/me/a%h/$test'],
  });
  assert.ok(unit.includes('ExecStart="/usr/bin/node" "/home/me/gateway dist/index.js" "gateway" "--strict-roots" "--roots" "/home/me/a%%h/$$test"\n'));
  assert.match(unit, /\nWantedBy=default.target\n/);
  assert.match(unit, /\nUMask=0077\n/);
  assert.throws(() => renderSystemdUnit({ nodePath: '/usr/bin/node', entryPath: 'a\nb', workingDirectory: '/home/me' }), /control characters/);
});
