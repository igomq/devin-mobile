import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBin } from '../src/harnesses/acp-generic.js';
import { fallbackBinDirs, gatewayPath, loginShellPath, mergePath } from '../src/shell-path.js';

test('mergePath keeps the first occurrence and drops empty entries', () => {
  assert.equal(mergePath('/a:/b', null, '/b::/c', undefined, '/a'), '/a:/b:/c');
});

test('fallback dirs include the ACP adapter and nvm install locations', () => {
  const home = mkdtempSync(join(tmpdir(), 'uniharn-home-'));
  try {
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v26.1.0', 'bin'), { recursive: true });
    const dirs = fallbackBinDirs(home);
    assert.ok(dirs.includes(join(home, '.local', 'bin')));
    assert.ok(dirs.includes(join(home, '.local', 'opt', 'node', 'bin')));
    assert.ok(dirs.includes(join(home, '.nvm', 'versions', 'node', 'v26.1.0', 'bin')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveBin finds an ACP adapter outside PATH in ~/.local/opt/node/bin', () => {
  const home = mkdtempSync(join(tmpdir(), 'uniharn-home-'));
  const previous = process.env.HOME;
  try {
    const dir = join(home, '.local', 'opt', 'node', 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codex-acp-test'), '#!/bin/sh\n');
    chmodSync(join(dir, 'codex-acp-test'), 0o755);
    process.env.HOME = home;
    assert.equal(resolveBin('codex-acp-test', { PATH: '/usr/bin:/bin' }), join(dir, 'codex-acp-test'));
  } finally {
    process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('the login shell PATH is merged after the current PATH', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'uniharn-home-'));
  try {
    const shell = join(home, 'fake-shell');
    writeFileSync(shell, '#!/bin/sh\nPATH=/from/profile:/usr/bin\nexport PATH\nexec /bin/sh "$@"\n');
    chmodSync(shell, 0o755);
    const env = { PATH: '/usr/bin:/bin', SHELL: shell, HOME: home };
    // System profile scripts may append more directories (e.g. /snap/bin).
    assert.match(loginShellPath(env) ?? '', /^\/from\/profile:\/usr\/bin/);
    const path = gatewayPath(env, home).split(':');
    assert.deepEqual(path.slice(0, 3), ['/usr/bin', '/bin', '/from/profile']);
    assert.ok(path.includes(join(home, '.local', 'opt', 'node', 'bin')));
    assert.equal(loginShellPath({ ...env, UNIHARN_LOGIN_SHELL_PATH: '0' }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the login shell does not inherit the master token', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'uniharn-home-'));
  try {
    const shell = join(home, 'fake-shell');
    writeFileSync(shell, '#!/bin/sh\nPATH="/token-${UNIHARN_TOKEN:-none}-${DEVIN_MOBILE_TOKEN:-none}"\nexport PATH\nexec /bin/sh "$@"\n');
    chmodSync(shell, 0o755);
    const path = loginShellPath({ PATH: '/usr/bin:/bin', SHELL: shell, HOME: home, UNIHARN_TOKEN: 'secret', DEVIN_MOBILE_TOKEN: 'old' });
    assert.match(path ?? '', /^\/token-none-none/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
