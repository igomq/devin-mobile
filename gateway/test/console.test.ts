import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { consoleAction, renderConsole, startConsole, type ConsoleInfo } from '../src/console.js';

const info: ConsoleInfo = { version: '0.3.0', gatewayId: 'abcdef1234567890', urls: ['http://vm.ts.net:8787', 'http://127.0.0.1:8787'], pairedDevices: 0, attached: false };
const pairing = { code: 'ABCD-EFGH', pairingUri: 'http://vm.ts.net:8787/#pair=ABCDEFGH', qrTerminal: '[qr]\n', expiresAt: Date.now() + 300_000 };

test('the console hides the QR and master token until asked', () => {
  const out = renderConsole(info, { pairing: null, showToken: false, notice: null }, 'secret-token');
  assert.match(out, /Gateway URL: +http:\/\/vm\.ts\.net:8787/);
  assert.match(out, /^ +http:\/\/127\.0\.0\.1:8787$/m);
  assert.match(out, /Master token: +hidden/);
  assert.doesNotMatch(out, /secret-token|\[qr\]/);
  assert.match(out, /Enter: show pairing QR/);
  assert.match(out, /q: stop the gateway/);
});

test('the console shows the QR, code and link, and the token when toggled', () => {
  const out = renderConsole({ ...info, attached: true }, { pairing, showToken: true, notice: null }, 'secret-token');
  assert.match(out, /\[qr\]/);
  assert.match(out, /Pairing code: +ABCD-EFGH/);
  assert.match(out, /Pairing link: +http:\/\/vm\.ts\.net:8787\/#pair=ABCDEFGH/);
  assert.match(out, /Master token: +secret-token/);
  assert.match(out, /running as a service/);
  assert.match(out, /Enter: hide pairing QR/);
  assert.match(out, /q: close \(the service keeps running\)/);
});

test('console keys map to actions', () => {
  assert.equal(consoleAction('\r'), 'toggle-pairing');
  assert.equal(consoleAction(' '), 'toggle-pairing');
  assert.equal(consoleAction('t'), 'toggle-token');
  assert.equal(consoleAction('q'), 'quit');
  assert.equal(consoleAction('\u0003'), 'quit');
  assert.equal(consoleAction('x'), null);
});

test('Enter creates a fresh pairing code and hides it again; q quits', async () => {
  const input = new PassThrough();
  let written = '';
  const output = { write: (s: string) => { written = s; return true; } } as unknown as NodeJS.WriteStream;
  let created = 0;
  let quit = false;
  startConsole({
    info: () => info, token: 't', input: input as never, output,
    createPairing: async () => { created++; return { ...pairing, code: `CODE-000${created}` }; },
    onQuit: () => { quit = true; },
  });
  assert.match(written, /Enter: show pairing QR/);
  input.write('\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(written, /CODE-0001/);
  input.write('\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.doesNotMatch(written, /CODE-0001/);
  input.write('\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(written, /CODE-0002/);
  input.write('q');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(quit, true);
});

test('the installed service unit round-trips to its launch arguments and token', async () => {
  const { parseServiceEnv, parseSystemdUnit, renderSystemdUnit } = await import('../src/diagnostics.js');
  const args = ['--port', '9999', '--public-url', 'https://vm.ts.net', '--roots', '/a "b"/100%', '--devin', '/x/$HOME\\bin'];
  const unit = renderSystemdUnit({ nodePath: '/usr/bin/node', entryPath: '/g/dist/index.js', workingDirectory: '/g/dist', args, environmentFile: '/d/service.env' });
  const { command, environmentFile } = parseSystemdUnit(unit);
  assert.deepEqual(command, ['/usr/bin/node', '/g/dist/index.js', 'gateway', ...args]);
  assert.equal(environmentFile, '/d/service.env');
  assert.deepEqual(parseServiceEnv('UNIHARN_TOKEN="a\\"b\\\\c"\n'), { UNIHARN_TOKEN: 'a"b\\c' });
  assert.deepEqual(parseServiceEnv(''), {});
});
