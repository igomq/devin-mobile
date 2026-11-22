import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { pairingLink, AuthStore, PairingCodeError } from '../src/auth.js';

const master = 'unit-master-secret';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const exec = promisify(execFile);

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { mode: 0o755 });
  return { dataDir, auth: new AuthStore(dataDir, master) };
}

test('pairing persists only the code hash, creates both QR formats, and exchanges normalized input once', async (t) => {
  const { auth, dataDir } = fixture(t);
  const url = 'https://example.test:8787/gateway';
  const createdAt = 1_750_000_000_000;
  t.mock.method(Date, 'now', () => createdAt);
  const pair = await auth.createPairingCode({ url });
  const plain = pair.code.replace('-', '');
  assert.match(pair.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(pair.pairingUri, `${url}/#pair=${pair.code}`);
  assert.match(pair.qrSvg, /^<svg\b/);
  assert.match(pair.qrTerminal, /[▀▄█]/);
  assert.equal(pair.expiresAt - createdAt, 300_000);
  const [listed] = auth.listPairingCodes();
  assert.deepEqual(listed, {
    codeId: pair.codeId, codeHint: plain.slice(0, 4), createdAt,
    expiresAt: pair.expiresAt, usedAt: null, revokedAt: null,
  });
  const pairingFile = join(dataDir, 'pairing.json');
  const stored = readFileSync(pairingFile, 'utf8');
  assert.equal(JSON.parse(stored)[0].codeHash, digest(plain));
  assert.ok(!stored.includes(plain) && !stored.includes(pair.code));
  const other = new AuthStore(dataDir);
  assert.match(auth.gatewayId, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
  assert.equal(other.gatewayId, auth.gatewayId);
  assert.equal(readFileSync(join(dataDir, 'gateway-id'), 'utf8').trim(), auth.gatewayId);
  const { device, token } = other.exchangePairingCode(` ${pair.code.toLowerCase().replace('-', ' - ')} `, {
    deviceName: 'my phone', platform: 'iOS', ip: '127.0.0.1',
  });
  assert.deepEqual(device, {
    deviceId: device.deviceId, name: 'my phone', platform: 'iOS', tokenPrefix: token.slice(0, 10),
    createdAt, lastSeenAt: createdAt, lastIp: '127.0.0.1', revokedAt: null,
  });
  assert.match(token, /^uhd_[A-Za-z0-9_-]{43}$/);
  assert.match(device.deviceId, /^dev_[a-f0-9]{16}$/);
  assert.equal(auth.listPairingCodes().length, 0);
  assert.throws(() => auth.exchangePairingCode(pair.code, {}), { message: 'Pairing code has already been used' });
  const devicesFile = join(dataDir, 'devices.json');
  const storedDevices = readFileSync(devicesFile, 'utf8');
  assert.equal(JSON.parse(storedDevices)[0].tokenHash, digest(token));
  assert.ok(!storedDevices.includes(token));
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  for (const file of [pairingFile, devicesFile, join(dataDir, 'gateway-id')]) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test('pairing TTL is clamped, invalid and revoked codes fail, and credentials are barred from pairing URLs', async (t) => {
  const { auth } = fixture(t);
  let now = 123_456;
  t.mock.method(Date, 'now', () => now);
  const short = await auth.createPairingCode({ ttlSec: 1 });
  const long = await auth.createPairingCode({ ttlSec: 2000 });
  assert.equal(short.pairingUri, `uniharn://pair?code=${short.code}`);
  assert.equal(short.expiresAt, now + 30_000);
  assert.equal(long.expiresAt, now + 900_000);
  assert.equal(auth.revokePairingCode(long.codeId), true);
  assert.equal(auth.revokePairingCode(long.codeId), false);
  assert.throws(() => auth.exchangePairingCode(long.code, {}), { name: 'Error', message: 'Invalid pairing code' });
  assert.throws(() => auth.exchangePairingCode('OO00-1III', {}), PairingCodeError);
  now = short.expiresAt;
  assert.throws(() => auth.exchangePairingCode(short.code, {}), { message: 'Pairing code has expired' });
  assert.deepEqual(auth.listPairingCodes(), []);
  for (const url of [
    'file:///tmp/test', 'https://user:secret@example.test', 'https://example.test?token=hello',
    'https://example.test/#token=hello', 'https://example.test/uhd_token', `https://example.test/${master}`,
  ]) {
    await assert.rejects(auth.createPairingCode({ url }), /Pairing URL/);
  }
  assert.deepEqual(auth.listPairingCodes(), []);
});

test('multiple stores see device activity, rename, rotation, and revocation immediately', async (t) => {
  const { auth, dataDir } = fixture(t);
  let now = 1;
  t.mock.method(Date, 'now', () => now);
  const cli = new AuthStore(dataDir);
  const { device, token } = cli.exchangePairingCode((await auth.createPairingCode()).code, {});
  now = 2;
  assert.deepEqual(auth.authenticate(token, master, '127.0.0.2'), {
    ok: true, authKind: 'device', deviceId: device.deviceId, deviceName: 'Unnamed device',
  });
  assert.deepEqual(cli.listDevices(device.deviceId)[0], { ...device, lastSeenAt: 2, lastIp: '127.0.0.2', current: true });
  assert.equal(cli.listDevices()[0].current, false);
  assert.deepEqual(auth.authenticate(master, master), { ok: true, authKind: 'master', deviceId: null, deviceName: 'Master token' });
  assert.deepEqual(auth.authenticate('wrong credential', master), { ok: false, reason: 'invalid', error: 'Invalid token' });
  cli.renameDevice(device.deviceId, '  Tablet ');
  assert.equal(auth.listDevices()[0].name, 'Tablet');
  assert.throws(() => cli.renameDevice(device.deviceId, ' '), /name is required/);
  const rotated = cli.rotateDeviceToken(device.deviceId);
  assert.notEqual(rotated.token, token);
  assert.deepEqual(auth.authenticate(token, master), { ok: false, reason: 'invalid', error: 'Invalid token' });
  assert.equal(auth.authenticate(rotated.token, master).ok, true);
  now = 3;
  assert.equal(cli.revokeDevice(device.deviceId).revokedAt, now);
  now = 4;
  assert.equal(cli.revokeDevice(device.deviceId).revokedAt, 3);
  assert.deepEqual(auth.authenticate(rotated.token, master), {
    ok: false, reason: 'revoked', error: 'Device token has been revoked', deviceId: device.deviceId,
  });
  assert.throws(() => auth.rotateDeviceToken(device.deviceId), /Device token has been revoked/);
  assert.throws(() => cli.revokeDevice('dev_missing'), /Device not found/);
  cli.exchangePairingCode((await auth.createPairingCode()).code, {});
  cli.exchangePairingCode((await auth.createPairingCode()).code, {});
  assert.equal(auth.revokeAllDevices(), 2);
  assert.equal(cli.revokeAllDevices(), 0);
  assert.ok(cli.listDevices().every((row) => row.revokedAt !== null));
});

test('simultaneous exchanges from separate processes consume a code exactly once', async (t) => {
  const { auth, dataDir } = fixture(t);
  const { code } = await auth.createPairingCode();
  const source = new URL('../src/auth.ts', import.meta.url).href;
  const exchange = `
    import { AuthStore, PairingCodeError } from ${JSON.stringify(source)};
    try {
      new AuthStore(process.argv[1]).exchangePairingCode(process.argv[2], {});
      console.log('exchanged');
    } catch (error) {
      if (!(error instanceof PairingCodeError)) throw error;
      console.log(error.message);
    }
  `;
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', exchange, dataDir, code])));
  assert.equal(results.filter(({ stdout }) => stdout.trim() === 'exchanged').length, 1);
  assert.equal(results.filter(({ stdout }) => stdout.trim() === 'Pairing code has already been used').length, 3);
  assert.equal(auth.listDevices().length, 1);
});

test('pairingLink opens the gateway web app with the code only in the fragment', () => {
  assert.equal(pairingLink('ws://100.64.0.1:8787/ws', 'ABCD-EFGH'), 'http://100.64.0.1:8787/#pair=ABCD-EFGH');
  assert.equal(pairingLink('wss://vm.tailnet.ts.net', 'ABCD-EFGH'), 'https://vm.tailnet.ts.net/#pair=ABCD-EFGH');
  assert.equal(pairingLink(undefined, 'ABCD-EFGH'), 'uniharn://pair?code=ABCD-EFGH');
});
