import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'uniharn-config-test-'));
}

test('loadConfig uses UNIHARN_* env vars and supports `uniharn gateway` subcommand', () => {
  const home = makeTempHome();
  try {
    const cfg = loadConfig({
      argv: ['node', 'uniharn', 'gateway', '--port', '9191', '--host', '127.0.0.1'],
      env: {
        UNIHARN_TOKEN: 'secret-tok',
        DEVIN_MOBILE_TOKEN: 'legacy-tok',
        UNIHARN_STATIC: 'none',
      },
      home,
      detectTailscale: () => null,
    });
    assert.equal(cfg.port, 9191);
    assert.deepEqual(cfg.hosts, ['127.0.0.1']);
    assert.equal(cfg.token, 'secret-tok');
    assert.equal(cfg.dataDir, join(home, '.local/share/uniharn'));
    assert.equal(cfg.staticDir, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadConfig falls back to legacy DEVIN_MOBILE_* env vars', () => {
  const home = makeTempHome();
  try {
    const cfg = loadConfig({
      argv: ['node', 'uniharn-gateway'],
      env: {
        DEVIN_MOBILE_TOKEN: 'legacy-tok',
        DEVIN_MOBILE_PORT: '9292',
        DEVIN_MOBILE_HOST: '127.0.0.1',
        DEVIN_MOBILE_STATIC: 'none',
      },
      home,
      detectTailscale: () => null,
    });
    assert.equal(cfg.port, 9292);
    assert.equal(cfg.token, 'legacy-tok');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadConfig automatically migrates legacy token from ~/.local/share/devin-mobile/token', () => {
  const home = makeTempHome();
  try {
    const legacyDir = join(home, '.local/share/devin-mobile');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'token'), 'migrated-legacy-token\n', { mode: 0o600 });

    const cfg = loadConfig({
      argv: ['node', 'uniharn', 'gateway', '--host', '127.0.0.1'],
      env: { UNIHARN_STATIC: 'none' },
      home,
      detectTailscale: () => null,
    });
    assert.equal(cfg.legacyMigrated, true);
    assert.equal(cfg.token, 'migrated-legacy-token');
    const copied = readFileSync(join(home, '.local/share/uniharn/token'), 'utf8').trim();
    assert.equal(copied, 'migrated-legacy-token');
    const mode = statSync(join(home, '.local/share/uniharn/token')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
