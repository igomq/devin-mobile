import type { Json } from './types';

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'auth_failed';

type Listener = (msg: Json) => void;

/**
 * WebSocket client for the devin-mobile gateway with request/response correlation and
 * automatic reconnect (exponential backoff + immediate retry on network/visibility changes).
 */
export class GatewayClient {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
	private listeners = new Map<string, Set<Listener>>();
	private retry = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private wanted = false;
	state: ConnState = 'idle';
	lastError: string | null = null;

	constructor(
		private url: string,
		private token: string,
		private onState: (s: ConnState, err: string | null) => void,
		private onHello: (hello: Json) => void
	) {
		if (typeof window !== 'undefined') {
			window.addEventListener('online', this.kick);
			document.addEventListener('visibilitychange', this.onVisible);
		}
	}

	private kick = () => {
		if (!this.wanted) return;
		if (this.state === 'open') {
			this.request('ping', {}, 4000).catch(() => this.ws?.close());
			return;
		}
		if (this.state !== 'connecting') {
			this.retry = 0;
			this.open();
		}
	};
	private onVisible = () => {
		if (document.visibilityState === 'visible') this.kick();
	};

	connect() {
		this.wanted = true;
		this.open();
	}

	dispose() {
		this.wanted = false;
		if (this.timer) clearTimeout(this.timer);
		if (this.heartbeat) clearInterval(this.heartbeat);
		window.removeEventListener('online', this.kick);
		document.removeEventListener('visibilitychange', this.onVisible);
		this.ws?.close();
		this.ws = null;
	}

	private setState(s: ConnState, err: string | null = null) {
		this.state = s;
		this.lastError = err;
		this.onState(s, err);
	}

	private open() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.setState('connecting', this.lastError);
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.url);
		} catch (e: Json) {
			this.setState('closed', String(e?.message ?? e));
			this.schedule();
			return;
		}
		this.ws = ws;
		ws.onopen = async () => {
			try {
				const hello = await this.request('hello', { token: this.token }, 15000);
				this.retry = 0;
				this.setState('open');
				this.onHello(hello);
				if (this.heartbeat) clearInterval(this.heartbeat);
				this.heartbeat = setInterval(() => {
					if (this.state === 'open') this.request('ping', {}, 10000).catch(() => ws.close());
				}, 25000);
			} catch (e: Json) {
				const msg = String(e?.message ?? e);
				if (/token|auth/i.test(msg)) {
					this.wanted = false;
					this.setState('auth_failed', msg);
				}
				ws.close();
			}
		};
		ws.onmessage = (ev) => {
			let msg: Json;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (msg.type === 'response') {
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				if (msg.ok) p.resolve(msg.result);
				else p.reject(new Error(msg.error ?? 'Request failed'));
				return;
			}
			this.listeners.get(msg.type)?.forEach((fn) => fn(msg));
			this.listeners.get('*')?.forEach((fn) => fn(msg));
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			if (this.heartbeat) clearInterval(this.heartbeat);
			for (const p of this.pending.values()) p.reject(new Error('Disconnected'));
			this.pending.clear();
			if (this.state !== 'auth_failed') this.setState('closed', this.lastError);
			this.schedule();
		};
		ws.onerror = () => {
			this.lastError = 'Cannot reach gateway';
		};
	}

	private schedule() {
		if (!this.wanted || this.timer) return;
		const delay = Math.min(10000, 400 * 2 ** this.retry++) + Math.random() * 300;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.open();
		}, delay);
	}

	request<T = Json>(type: string, params: Json = {}, timeoutMs = 60000): Promise<T> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected'));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			let t: ReturnType<typeof setTimeout> | null = null;
			if (timeoutMs > 0)
				t = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`Timed out: ${type}`));
				}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					if (t) clearTimeout(t);
					resolve(v);
				},
				reject: (e) => {
					if (t) clearTimeout(t);
					reject(e);
				}
			});
			ws.send(JSON.stringify({ ...params, id, type }));
		});
	}

	/** Fire-and-forget (no response expected), e.g. terminal keystrokes. */
	send(type: string, params: Json = {}) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ...params, type }));
	}

	on(type: string, fn: Listener): () => void {
		let set = this.listeners.get(type);
		if (!set) this.listeners.set(type, (set = new Set()));
		set.add(fn);
		return () => set!.delete(fn);
	}
}
