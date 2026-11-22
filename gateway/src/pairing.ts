import type { IncomingMessage, ServerResponse } from 'node:http';
import { type AuthStore, PairingCodeError } from './auth.js';
import { RateLimiter } from './security.js';

export class RequestError extends Error {
  constructor(public statusCode: number, message: string, public retryAfterMs?: number) {
    super(message);
  }
}

export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
}

export function checkRateLimit(limiter: RateLimiter, ip: string): void {
  const retryAfterMs = limiter.retryAfterMs(ip);
  if (retryAfterMs > 0) throw new RequestError(429, 'Too many attempts; try again later', retryAfterMs);
}

export function exchangePairingCode(authStore: AuthStore, limiter: RateLimiter, ip: string, params: Record<string, unknown>) {
  checkRateLimit(limiter, ip);
  try {
    const code = typeof params.code === 'string' ? params.code : '';
    const result = authStore.exchangePairingCode(code, {
      deviceName: typeof params.deviceName === 'string' ? params.deviceName : undefined,
      platform: typeof params.platform === 'string' ? params.platform : undefined,
      ip,
    });
    limiter.reset(ip);
    return result;
  } catch (error) {
    if (!(error instanceof PairingCodeError)) throw error;
    limiter.recordFailure(ip);
    throw new RequestError(401, error.message);
  }
}

const MAX_PAIR_BODY = 8 * 1024;

function allowPairOrigin(origin: string, host: string | undefined): boolean {
  if (origin === 'tauri://localhost') return true;
  try {
    const url = new URL(origin);
    return url.origin === origin && ['http:', 'https:'].includes(url.protocol) &&
      (url.host === host || ['tauri.localhost', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

async function readPairBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(req.headers['content-length']) > MAX_PAIR_BODY) throw new RequestError(413, 'Request body is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_PAIR_BODY) throw new RequestError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Report malformed and non-object bodies uniformly.
  }
  throw new RequestError(400, 'Expected a JSON object');
}

export function sendJson(res: ServerResponse, status: number, value: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
}

export async function handlePairRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authStore: AuthStore,
  limiter: RateLimiter,
  info: object,
): Promise<void> {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  try {
    if (origin) {
      if (!allowPairOrigin(origin, req.headers.host)) throw new RequestError(403, 'Origin is not allowed');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      throw new RequestError(405, 'Method not allowed');
    }
    const ip = clientIp(req);
    checkRateLimit(limiter, ip);
    const params = await readPairBody(req);
    const { device, token } = exchangePairingCode(authStore, limiter, ip, params);
    sendJson(res, 200, { ok: true, deviceId: device.deviceId, token, device, ...info });
  } catch (error) {
    if (!(error instanceof RequestError)) throw error;
    req.resume();
    if (error.retryAfterMs !== undefined) res.setHeader('Retry-After', Math.ceil(error.retryAfterMs / 1000));
    sendJson(res, error.statusCode, { ok: false, error: error.message });
  }
}
