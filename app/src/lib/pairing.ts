// Pairing with a gateway: parse what the user pasted or scanned, and exchange a one-time code for a
// per-device token. Pure TypeScript (no Svelte) so it can be unit tested. Never log codes or tokens.

export interface PairingInput {
	url?: string;
	code?: string;
	token?: string;
}

export interface PairResult {
	deviceId: string;
	token: string;
	gatewayId?: string;
	hostname?: string;
	version?: string;
	protocolVersion?: number;
	minAppVersion?: string;
	device?: { deviceId: string; name: string; platform: string | null };
}

/** Uppercases, drops anything that is not a letter or digit and inserts the hyphen: `abcd efgh` → `ABCD-EFGH`. */
export function normalizeCode(raw: string): string {
	const plain = raw
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '')
		.slice(0, 8);
	return plain.length > 4 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain;
}

/** A complete code (8 characters, with or without the hyphen). */
export function isCompleteCode(raw: string): boolean {
	return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalizeCode(raw));
}

function stripBase(u: URL): string {
	const path = u.pathname.replace(/\/+$/, '');
	return u.origin + path;
}

/**
 * Accepts everything a user can paste or a QR code can carry:
 * - `http(s)://host[:port]/#pair=CODE` (fragment may hold several `&`-joined params)
 * - `uniharn://pair?url=<encoded>&code=CODE` (url optional)
 * - legacy `http(s)://host/#token=TOKEN`
 * - a bare code `ABCD-EFGH` / `abcdefgh`
 * - a bare gateway address (returned as `url`)
 */
export function parsePairingInput(text: string): PairingInput {
	const raw = text.trim();
	if (!raw) return {};
	if (/^uniharn:/i.test(raw)) {
		const query = raw.replace(/^uniharn:\/*[^?#]*/i, '').replace(/^[?#]/, '');
		const params = new URLSearchParams(query);
		const out: PairingInput = {};
		const code = params.get('code') ?? params.get('pair');
		const url = params.get('url');
		const token = params.get('token');
		if (code) out.code = normalizeCode(code);
		if (url) out.url = url.trim().replace(/\/+$/, '');
		if (token) out.token = token;
		return out;
	}
	if (/^(https?|wss?):\/\//i.test(raw)) {
		let u: URL;
		try {
			u = new URL(raw);
		} catch {
			return {};
		}
		const params = new URLSearchParams(u.hash.replace(/^#\/?/, ''));
		const out: PairingInput = {};
		const code = params.get('pair');
		const token = params.get('token');
		if (code) out.code = normalizeCode(code);
		if (token) out.token = token;
		u.hash = '';
		u.search = '';
		out.url = stripBase(u);
		return out;
	}
	if (/^[A-Za-z0-9]{4}[-\s]?[A-Za-z0-9]{4}$/.test(raw)) return { code: normalizeCode(raw) };
	return {};
}

export const DEFAULT_PORT = '8787';

/** HTTP base of a gateway address, following the same rules as `wsUrl()` in api.svelte.ts. */
export function httpBase(input: string): string {
	let u = input.trim();
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
	u = u.replace(/^ws(s?):\/\//i, 'http$1://');
	const explicitPort = /^[a-z]+:\/\/(\[[^\]]*\]|[^/:?#]*):\d+/i.test(u);
	const parsed = new URL(u);
	if (!/^https?:$/.test(parsed.protocol)) throw new Error('That server address is not valid.');
	if (!explicitPort && parsed.protocol === 'http:') parsed.port = DEFAULT_PORT;
	parsed.hash = '';
	parsed.search = '';
	parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, '').replace(/\/+$/, '');
	return stripBase(parsed);
}

const PAIR_TIMEOUT_MS = 15000;
const UNREACHABLE = 'Cannot reach the gateway. Check that Tailscale is connected.';

export async function pairDevice(url: string, code: string, deviceName: string, platform: string): Promise<PairResult> {
	let endpoint: string;
	try {
		endpoint = httpBase(url) + '/api/pair';
	} catch {
		throw new Error('That server address is not valid.');
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: normalizeCode(code), deviceName, platform }),
			signal: controller.signal,
			cache: 'no-store',
			credentials: 'omit',
			referrerPolicy: 'no-referrer'
		});
	} catch (err) {
		throw new Error(controller.signal.aborted ? 'The gateway did not answer in time. Check that Tailscale is connected.' : UNREACHABLE);
	} finally {
		clearTimeout(timer);
	}
	let body: Record<string, unknown> = {};
	try {
		body = await res.json();
	} catch {
		// Non-JSON answers fall through to the status-based messages below.
	}
	const serverError = typeof body.error === 'string' && body.error ? body.error : null;
	if (res.status === 429) throw new Error('Too many attempts, wait a minute.');
	if (res.status === 401) throw new Error(friendlyCodeError(serverError));
	if (res.status === 404 || res.status === 405) throw new Error('This gateway does not support pairing codes. Update it, or use an access token instead.');
	if (!res.ok || body.ok !== true) throw new Error(serverError ?? `Pairing failed (HTTP ${res.status}).`);
	if (typeof body.token !== 'string' || typeof body.deviceId !== 'string') throw new Error('The gateway sent an unexpected answer.');
	return body as unknown as PairResult;
}

function friendlyCodeError(message: string | null): string {
	if (!message) return 'That pairing code was not accepted.';
	if (/expired/i.test(message)) return 'That pairing code has expired. Run uniharn pair on the VM for a new one.';
	if (/already been used/i.test(message)) return 'That pairing code was already used. Run uniharn pair on the VM for a new one.';
	if (/invalid/i.test(message)) return 'That pairing code is not valid. Check it, or run uniharn pair on the VM for a new one.';
	return message;
}

function nav(): { ua: string; touch: number; standalone: boolean } {
	if (typeof navigator === 'undefined') return { ua: '', touch: 0, standalone: false };
	const standalone =
		typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);
	return { ua: navigator.userAgent || '', touch: navigator.maxTouchPoints || 0, standalone: Boolean(standalone) };
}

function inApp(): boolean {
	return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || location.hostname === 'tauri.localhost' || location.protocol === 'tauri:');
}

type Os = 'iphone' | 'ipad' | 'android' | 'mac' | 'windows' | 'linux' | 'other';

function detectOs(): Os {
	const { ua, touch } = nav();
	if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'ipad';
	if (/iPhone|iPod/.test(ua)) return 'iphone';
	if (/Android/.test(ua)) return 'android';
	if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
	if (/Windows/.test(ua)) return 'windows';
	if (/Linux|X11|CrOS/.test(ua)) return 'linux';
	return 'other';
}

function browserName(): string {
	const { ua } = nav();
	if (/Edg\//.test(ua)) return 'Edge';
	if (/Firefox\/|FxiOS/.test(ua)) return 'Firefox';
	if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
	if (/Chrome\/|CriOS/.test(ua)) return 'Chrome';
	if (/Safari\//.test(ua)) return 'Safari';
	return 'Browser';
}

/** `ios-app`, `android-browser`, `desktop-app`, … */
export function detectPlatform(): string {
	const os = detectOs();
	const family = os === 'iphone' || os === 'ipad' ? 'ios' : os === 'android' ? 'android' : 'desktop';
	const { standalone } = nav();
	return `${family}-${inApp() ? 'app' : standalone ? 'pwa' : 'browser'}`;
}

/** A readable default name such as `iPhone`, `Android phone (Chrome)` or `Mac (Safari)`. */
export function defaultDeviceName(): string {
	const os = detectOs();
	const { ua } = nav();
	const base: Record<Os, string> = {
		iphone: 'iPhone',
		ipad: 'iPad',
		android: /Mobile/.test(ua) ? 'Android phone' : 'Android tablet',
		mac: 'Mac',
		windows: 'Windows PC',
		linux: 'Linux',
		other: 'Device'
	};
	return inApp() ? base[os] : `${base[os]} (${browserName()})`;
}

/** Compares dotted versions numerically: negative when a < b. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
	const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d;
	}
	return 0;
}
