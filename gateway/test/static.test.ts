import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from '../src/static.js';

test('the served app may use the camera on its own origin only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uniharn-static-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  const server = createServer((req, res) => serveStatic(root, req, res));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('permissions-policy') ?? '', /camera=\(self\)/);
    assert.match(res.headers.get('permissions-policy') ?? '', /microphone=\(\)/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
