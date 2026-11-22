import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { redactSecrets } from './security.js';

export const PROTOCOL_VERSION = 2;
export const MIN_APP_VERSION = '0.3.0';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TERMINAL_QR_OPTIONS = { type: 'utf8' as const, small: true };
const LOCK_STALE_MS = 10_000;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

interface PairingCode {
  codeId: string;
  codeHint: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

interface StoredPairingCode extends PairingCode {
  codeHash: string;
}

export interface Device {
  deviceId: string;
  name: string;
  platform: string | null;
  tokenPrefix: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string | null;
  revokedAt: number | null;
}

interface StoredDevice extends Device {
  tokenHash: string;
}

interface PairingMeta {
  deviceName?: string;
  platform?: string;
  ip?: string;
}

export type Authentication =
  | { ok: true; authKind: 'device' | 'master'; deviceId: string | null; deviceName: string }
  | { ok: false; reason: 'revoked'; error: string; deviceId: string }
  | { ok: false; reason: 'invalid'; error: string };

export class PairingCodeError extends Error {}

function hash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function hashMatches(digest: Buffer, storedHash: string): boolean {
  const stored = Buffer.from(storedHash, 'hex');
  return stored.length === digest.length && timingSafeEqual(digest, stored);
}

function safeDevice({ tokenHash: _hash, ...device }: StoredDevice): Device {
  return device;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function readRows<T>(file: string): T[] {
  try {
    const rows: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('Invalid auth store file');
    return rows;
  } catch (error) {
    if (isMissing(error)) return [];
    if (error instanceof SyntaxError) throw new Error('Invalid auth store file');
    throw error;
  }
}

function writePrivateFile(file: string, contents: string): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function writeRows<T>(file: string, rows: T[]): void {
  writePrivateFile(file, JSON.stringify(rows, null, 2) + '\n');
}

export function validatePairingUrl(target: string, masterToken?: string): void {
  let parsed: URL;
  let decoded: string;
  try {
    parsed = new URL(target);
    decoded = decodeURIComponent(target);
  } catch {
    throw new Error('Pairing URL must be a valid HTTP or WebSocket URL');
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) ||
      !parsed.hostname || parsed.username || parsed.password || /[?#]/.test(decoded) ||
      redactSecrets(decoded, masterToken ? [masterToken] : []) !== decoded) {
    throw new Error('Pairing URL must be an HTTP or WebSocket URL without credentials, a query, or a fragment');
  }
}

/**
 * The QR payload. With a known gateway URL it is the gateway's web app with the code in the URL
 * fragment, which browsers never send to the server, so a phone camera can open it directly and the
 * app can scan it. The code is single-use and short-lived; no token is ever put in the link.
 */
export function pairingLink(url: string | undefined, code: string): string {
  if (!url) return `uniharn://pair?code=${code}`;
  const base = new URL(url);
  if (base.protocol === 'ws:') base.protocol = 'http:';
  else if (base.protocol === 'wss:') base.protocol = 'https:';
  base.pathname = base.pathname.replace(/\/ws\/?$/, '/').replace(/\/*$/, '/');
  return `${base.origin}${base.pathname}#pair=${code}`;
}

export class AuthStore {
  readonly gatewayId: string;
  private readonly pairingFile: string;
  private readonly devicesFile: string;
  private readonly lockFile: string;
  private devices: StoredDevice[] = [];
  private devicesRevision: string | undefined;

  constructor(dataDir: string, private readonly masterToken?: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.pairingFile = join(dataDir, 'pairing.json');
    this.devicesFile = join(dataDir, 'devices.json');
    this.lockFile = join(dataDir, '.auth.lock');
    const idFile = join(dataDir, 'gateway-id');
    this.gatewayId = this.withLock(() => {
      try {
        const id = readFileSync(idFile, 'utf8').trim();
        chmodSync(idFile, 0o600);
        return id;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const id = randomUUID();
      writePrivateFile(idFile, id + '\n');
      return id;
    });
  }

  private withLock<T>(operation: () => T): T {
    // The gateway and the `uniharn pair` / `uniharn devices` CLI share this lock. A lock left by a
    // crashed process is taken over once it is older than any real auth-store write.
    const deadline = performance.now() + 2000;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(this.lockFile, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(this.lockFile).mtimeMs > LOCK_STALE_MS) rmSync(this.lockFile, { force: true });
        } catch (statError) {
          if (!isMissing(statError)) throw statError;
        }
        if (performance.now() >= deadline) throw new Error('Auth store is busy; try again');
        Atomics.wait(lockWait, 0, 0, 5);
      }
    }
    try {
      return operation();
    } finally {
      closeSync(fd);
      rmSync(this.lockFile, { force: true });
    }
  }

  private reloadDevices(): void {
    let revision: string;
    try {
      const stat = statSync(this.devicesFile, { bigint: true });
      revision = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.devices = [];
      this.devicesRevision = undefined;
      return;
    }
    if (revision !== this.devicesRevision) {
      this.devices = readRows<StoredDevice>(this.devicesFile);
      this.devicesRevision = revision;
    }
  }

  private updateDevices<T>(update: (devices: StoredDevice[]) => T): T {
    return this.withLock(() => {
      this.reloadDevices();
      const next = this.devices.map((device) => ({ ...device }));
      const result = update(next);
      if (result !== undefined) writeRows(this.devicesFile, next);
      return result;
    });
  }

  async createPairingCode(opts: { ttlSec?: number; url?: string } = {}) {
    if (opts.url) validatePairingUrl(opts.url, this.masterToken);
    const ttl = Math.min(900, Math.max(30, Number.isNaN(opts.ttlSec) ? 300 : opts.ttlSec ?? 300));
    for (;;) {
      const plain = Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
      const code = `${plain.slice(0, 4)}-${plain.slice(4)}`;
      const uri = pairingLink(opts.url, code);
      const [qrSvg, qrTerminal] = await Promise.all([
        QRCode.toString(uri, { type: 'svg', margin: 1, width: 240 }),
        QRCode.toString(uri, TERMINAL_QR_OPTIONS),
      ]);
      const codeHash = hash(plain).toString('hex');
      const saved = this.withLock(() => {
        const rows = readRows<StoredPairingCode>(this.pairingFile);
        if (rows.some((row) => row.codeHash === codeHash)) return;
        const createdAt = Date.now();
        const codeId = randomUUID();
        const expiresAt = createdAt + ttl * 1000;
        rows.push({ codeId, codeHash, codeHint: plain.slice(0, 4), createdAt, expiresAt, usedAt: null, revokedAt: null });
        writeRows(this.pairingFile, rows);
        return { codeId, expiresAt };
      });
      if (saved) return { ...saved, code, pairingUri: uri, qrSvg, qrTerminal };
    }
  }

  listPairingCodes(): PairingCode[] {
    const now = Date.now();
    return readRows<StoredPairingCode>(this.pairingFile)
      .filter((row) => row.expiresAt > now && row.usedAt === null && row.revokedAt === null)
      .map(({ codeHash: _hash, ...row }) => row);
  }

  revokePairingCode(codeId: string): boolean {
    return this.withLock(() => {
      const rows = readRows<StoredPairingCode>(this.pairingFile);
      const row = rows.find((code) => code.codeId === codeId && code.revokedAt === null);
      if (!row) return false;
      row.revokedAt = Date.now();
      writeRows(this.pairingFile, rows);
      return true;
    });
  }

  exchangePairingCode(rawCode: string, meta: PairingMeta) {
    const plain = rawCode.replace(/[-\s]/g, '').toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(plain)) throw new PairingCodeError('Invalid pairing code');
    const digest = hash(plain);
    return this.withLock(() => {
      const codes = readRows<StoredPairingCode>(this.pairingFile);
      const code = codes.find((row) => hashMatches(digest, row.codeHash));
      const now = Date.now();
      if (!code || code.revokedAt !== null) throw new PairingCodeError('Invalid pairing code');
      if (code.usedAt !== null) throw new PairingCodeError('Pairing code has already been used');
      if (code.expiresAt <= now) throw new PairingCodeError('Pairing code has expired');

      this.reloadDevices();
      const token = `uhd_${randomBytes(32).toString('base64url')}`;
      const secrets = [rawCode, plain, `${plain.slice(0, 4)}-${plain.slice(4)}`, this.masterToken ?? ''];
      const device: StoredDevice = {
        deviceId: `dev_${randomBytes(8).toString('hex')}`,
        name: redactSecrets(meta.deviceName?.trim() || 'Unnamed device', secrets).slice(0, 128),
        platform: meta.platform?.trim() ? redactSecrets(meta.platform.trim(), secrets).slice(0, 64) : null,
        tokenHash: hash(token).toString('hex'),
        tokenPrefix: token.slice(0, 10),
        createdAt: now,
        lastSeenAt: now,
        lastIp: meta.ip ?? null,
        revokedAt: null,
      };
      // Consume the code first so a failed device write cannot make a code reusable.
      code.usedAt = now;
      writeRows(this.pairingFile, codes);
      writeRows(this.devicesFile, [...this.devices, device]);
      return { device: safeDevice(device), token };
    });
  }

  authenticate(token: string, masterToken: string, ip?: string): Authentication {
    const digest = hash(token);
    const matches = (device: StoredDevice) => hashMatches(digest, device.tokenHash);
    this.reloadDevices();
    if (this.devices.some(matches)) {
      const result = this.updateDevices((devices): Authentication | undefined => {
        const device = devices.find(matches);
        if (!device || device.revokedAt !== null) return;
        device.lastSeenAt = Date.now();
        device.lastIp = ip ?? device.lastIp;
        return { ok: true, authKind: 'device', deviceId: device.deviceId, deviceName: device.name };
      });
      if (result) return result;
      const revoked = this.devices.find(matches);
      if (revoked && revoked.revokedAt !== null) {
        return { ok: false, reason: 'revoked', error: 'Device token has been revoked', deviceId: revoked.deviceId };
      }
    }
    if (masterToken && timingSafeEqual(digest, hash(masterToken))) {
      return { ok: true, authKind: 'master', deviceId: null, deviceName: 'Master token' };
    }
    return { ok: false, reason: 'invalid', error: 'Invalid token' };
  }

  listDevices(currentDeviceId?: string | null) {
    this.reloadDevices();
    return this.devices.map((device) => ({ ...safeDevice(device), current: device.deviceId === currentDeviceId }));
  }

  private changeDevice<T>(deviceId: string, change: (device: StoredDevice) => T): T {
    return this.updateDevices((devices) => {
      const device = devices.find((row) => row.deviceId === deviceId);
      if (!device) throw new Error('Device not found');
      return change(device);
    });
  }

  renameDevice(deviceId: string, name: string): Device {
    if (!name.trim()) throw new Error('name is required');
    return this.changeDevice(deviceId, (device) => {
      device.name = redactSecrets(name.trim(), this.masterToken ? [this.masterToken] : []).slice(0, 128);
      return safeDevice(device);
    });
  }

  revokeDevice(deviceId: string): Device {
    return this.changeDevice(deviceId, (device) => {
      device.revokedAt ??= Date.now();
      return safeDevice(device);
    });
  }

  revokeAllDevices(): number {
    return this.updateDevices((devices) => {
      const active = devices.filter((device) => device.revokedAt === null);
      const now = Date.now();
      for (const device of active) device.revokedAt = now;
      return active.length;
    });
  }

  rotateDeviceToken(deviceId: string) {
    return this.changeDevice(deviceId, (device) => {
      if (device.revokedAt !== null) throw new Error('Device token has been revoked');
      const token = `uhd_${randomBytes(32).toString('base64url')}`;
      device.tokenHash = hash(token).toString('hex');
      device.tokenPrefix = token.slice(0, 10);
      return { device: safeDevice(device), token };
    });
  }
}
