import { GatewayClient, type ConnState } from './gateway';
import { Timeline } from './timeline.svelte';
import type { AgentStatus, Json, PendingPermission, SessionSummary, TerminalInfo } from './types';

const LS_URL = 'devin-mobile.url';
const LS_TOKEN = 'devin-mobile.token';
const LS_RECENT = 'devin-mobile.recentProjects';

export function isTauri() {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** When the UI is served by the gateway itself, the WebSocket lives on the same origin. */
export function sameOriginUrl(): string | null {
	if (typeof location === 'undefined' || isTauri()) return null;
	if (!/^https?:$/.test(location.protocol)) return null;
	if (location.port === '5173') return null; // vite dev server
	return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export function normalizeUrl(input: string): string {
	let u = input.trim();
	if (!u) return u;
	if (!/^[a-z]+:\/\//i.test(u)) u = `ws://${u}`;
	u = u.replace(/^http(s?):\/\//i, 'ws$1://');
	const explicitPort = /^[a-z]+:\/\/(\[[^\]]*\]|[^/:?#]*):\d+/i.test(u);
	const parsed = new URL(u);
	if (!explicitPort && parsed.protocol === 'ws:') parsed.port = '8787';
	if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/ws';
	return parsed.toString().replace(/\/$/, '');
}

class AppState {
	url = $state('');
	token = $state('');
	conn = $state<ConnState>('idle');
	connError = $state<string | null>(null);
	everConnected = $state(false);
	hostname = $state<string | null>(null);
	home = $state<string | null>(null);
	agent = $state<AgentStatus | null>(null);
	sessions = $state<Record<string, SessionSummary>>({});
	permissions = $state<Record<string, (PendingPermission & { title?: string | null })[]>>({});
	terminals = $state<TerminalInfo[]>([]);
	recentProjects = $state<string[]>([]);
	sessionsLoaded = $state(false);
	toast = $state<{ text: string; kind: 'info' | 'error' } | null>(null);

	client: GatewayClient | null = null;
	private timelines = new Map<string, Timeline>();
	private subscribed = new Set<string>();
	private syncing = new Map<string, Promise<void>>();
	private toastTimer: ReturnType<typeof setTimeout> | null = null;

	init() {
		if (typeof localStorage === 'undefined') return;
		const hash = new URLSearchParams(location.hash.slice(1));
		const pairToken = hash.get('token');
		if (pairToken) {
			localStorage.setItem(LS_TOKEN, pairToken);
			const so = sameOriginUrl();
			if (so) localStorage.setItem(LS_URL, so);
			history.replaceState(null, '', location.pathname + location.search);
		}
		this.url = localStorage.getItem(LS_URL) ?? sameOriginUrl() ?? '';
		this.token = localStorage.getItem(LS_TOKEN) ?? '';
		try {
			this.recentProjects = JSON.parse(localStorage.getItem(LS_RECENT) ?? '[]');
		} catch {
			this.recentProjects = [];
		}
		if (this.url && this.token) this.connect();
	}

	get configured() {
		return !!(this.url && this.token);
	}

	configure(url: string, token: string) {
		this.url = normalizeUrl(url);
		this.token = token.trim();
		localStorage.setItem(LS_URL, this.url);
		localStorage.setItem(LS_TOKEN, this.token);
		this.connect();
	}

	forget() {
		this.client?.dispose();
		this.client = null;
		localStorage.removeItem(LS_TOKEN);
		this.token = '';
		this.conn = 'idle';
		this.sessions = {};
		this.timelines.clear();
		this.subscribed.clear();
	}

	connect() {
		this.client?.dispose();
		const c = new GatewayClient(
			this.url,
			this.token,
			(s, err) => {
				this.conn = s;
				this.connError = err;
			},
			(hello) => this.onHello(hello)
		);
		this.client = c;
		c.on('event', (m) => this.onEvent(m));
		c.on('session_state', (m) => {
			this.sessions[m.session.sessionId] = m.session;
		});
		c.on('session_reset', (m) => {
			if (this.subscribed.has(m.sessionId)) this.syncSession(m.sessionId, true);
		});
		c.on('session_deleted', (m) => {
			delete this.sessions[m.sessionId];
			delete this.permissions[m.sessionId];
			this.timelines.delete(m.sessionId);
		});
		c.on('agent_status', (m) => (this.agent = m.agent));
		c.on('permission_request', (m) => {
			const list = this.permissions[m.sessionId] ?? [];
			if (!list.some((p) => p.requestId === m.requestId))
				this.permissions[m.sessionId] = [...list, { requestId: m.requestId, toolCall: m.toolCall, options: m.options, at: Date.now(), title: m.title }];
			notify('Approval needed', m.toolCall?.title ?? 'Devin is waiting for your permission');
		});
		c.on('permission_resolved', (m) => {
			const list = this.permissions[m.sessionId];
			if (list) this.permissions[m.sessionId] = list.filter((p) => p.requestId !== m.requestId);
			this.timelines.get(m.sessionId)?.markPermissionResolved(m.requestId, m.optionId ?? null);
		});
		c.on('term_exit', (m) => {
			this.terminals = this.terminals.map((t) => (t.termId === m.term.termId ? m.term : t));
		});
		c.connect();
	}

	private onHello(hello: Json) {
		this.everConnected = true;
		this.hostname = hello.hostname;
		this.home = hello.home;
		this.agent = hello.agent;
		this.terminals = hello.terminals ?? [];
		for (const s of hello.sessions ?? []) this.sessions[s.sessionId] = s;
		for (const id of this.subscribed) this.syncSession(id);
		this.refreshSessions();
		this.refreshPermissions();
	}

	private async refreshPermissions() {
		// Pending permissions of sessions we are not subscribed to are only known via summaries;
		// open those sessions lazily so the inbox can show them.
		for (const s of Object.values(this.sessions)) if (s.pendingPermissions > 0) this.syncSession(s.sessionId);
	}

	async refreshSessions() {
		if (!this.client) return;
		try {
			const r = await this.client.request<{ sessions: SessionSummary[] }>('sessions.list', {}, 30000);
			const next: Record<string, SessionSummary> = {};
			for (const s of r.sessions) next[s.sessionId] = s;
			this.sessions = next;
			this.sessionsLoaded = true;
		} catch (e) {
			this.showError(e);
		}
	}

	timeline(id: string): Timeline {
		let t = this.timelines.get(id);
		if (!t) this.timelines.set(id, (t = new Timeline()));
		return t;
	}

	subscribe(id: string) {
		this.subscribed.add(id);
		return this.syncSession(id);
	}

	unsubscribe(id: string) {
		this.subscribed.delete(id);
		this.client?.send('session.unsubscribe', { sessionId: id });
	}

	syncSession(id: string, full = false): Promise<void> {
		const running = this.syncing.get(id);
		if (running) return running;
		const p = this.doSync(id, full).finally(() => this.syncing.delete(id));
		this.syncing.set(id, p);
		return p;
	}

	private async doSync(id: string, full: boolean) {
		if (!this.client || this.conn !== 'open') return;
		const tl = this.timeline(id);
		const r = await this.client.request<Json>(
			'session.open',
			{ sessionId: id, cwd: this.sessions[id]?.cwd, epoch: full ? undefined : tl.epoch, sinceSeq: full ? 0 : tl.lastSeq },
			120000
		);
		this.sessions[id] = r.session;
		if (r.full || r.epoch !== tl.epoch) tl.reset(r.epoch);
		for (const ev of r.events) tl.apply(ev);
		this.permissions[id] = r.permissions.map((p: Json) => ({ ...p, title: r.session.title }));
		if (!this.subscribed.has(id)) this.client.send('session.unsubscribe', { sessionId: id });
	}

	private onEvent(m: Json) {
		const tl = this.timelines.get(m.sessionId);
		if (!tl) return;
		if (m.epoch !== tl.epoch || m.seq !== tl.lastSeq + 1) {
			if (m.epoch === tl.epoch && m.seq <= tl.lastSeq) return;
			this.syncSession(m.sessionId);
			return;
		}
		tl.apply(m);
		const u = m.update;
		if (u?.sessionUpdate === '_turn_end' || u?.sessionUpdate === '_turn_error') {
			const s = this.sessions[m.sessionId];
			notify(u.sessionUpdate === '_turn_end' ? 'Devin finished' : 'Devin hit an error', s?.title ?? baseName(s?.cwd ?? ''));
		}
	}

	async createSession(cwd: string): Promise<string> {
		const r = await this.req<Json>('session.create', { cwd }, 120000);
		this.sessions[r.session.sessionId] = r.session;
		this.timeline(r.session.sessionId).reset(r.epoch);
		this.subscribed.add(r.session.sessionId);
		this.rememberProject(cwd);
		return r.session.sessionId;
	}

	rememberProject(cwd: string) {
		this.recentProjects = [cwd, ...this.recentProjects.filter((p) => p !== cwd)].slice(0, 8);
		localStorage.setItem(LS_RECENT, JSON.stringify(this.recentProjects));
	}

	async req<T = Json>(type: string, params: Json = {}, timeoutMs = 60000): Promise<T> {
		if (!this.client) throw new Error('Not connected');
		return this.client.request<T>(type, params, timeoutMs);
	}

	showToast(text: string, kind: 'info' | 'error' = 'info') {
		this.toast = { text, kind };
		if (this.toastTimer) clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => (this.toast = null), 3500);
	}

	showError(e: unknown) {
		this.showToast(String((e as Json)?.message ?? e), 'error');
	}
}

export function baseName(p: string) {
	const parts = p.split('/').filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

export function shortPath(p: string, home: string | null) {
	if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
	return p;
}

export function relTime(t: number) {
	const d = (Date.now() - t) / 1000;
	if (d < 45) return 'now';
	if (d < 3600) return `${Math.round(d / 60)}m`;
	if (d < 86400) return `${Math.round(d / 3600)}h`;
	if (d < 86400 * 7) return `${Math.round(d / 86400)}d`;
	return new Date(t).toLocaleDateString();
}

function notify(title: string, body: string) {
	if (typeof document === 'undefined' || document.visibilityState === 'visible') return;
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
	try {
		new Notification(title, { body, tag: 'devin-mobile' });
	} catch {
		/* not supported in this webview */
	}
}

export const app = new AppState();
