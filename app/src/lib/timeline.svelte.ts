import type { Json, PermissionOption, SessionEvent } from './types';

export type ToolContent =
	| { type: 'text'; text: string }
	| { type: 'diff'; path: string; oldText: string | null; newText: string }
	| { type: 'terminal'; terminalId: string }
	| { type: 'other'; value: Json };

export type Item =
	| { kind: 'user'; key: string; text: string; images: number; at: number }
	| { kind: 'agent'; key: string; text: string; at: number }
	| { kind: 'thought'; key: string; text: string; at: number; open?: boolean }
	| {
			kind: 'tool';
			key: string;
			toolCallId: string;
			title: string;
			toolKind: string;
			status: string;
			content: ToolContent[];
			locations: { path: string; line?: number }[];
			rawInput: Json;
			rawOutput: Json;
			at: number;
	  }
	| { kind: 'plan'; key: string; entries: { content: string; status: string; priority?: string }[]; at: number }
	| {
			kind: 'permission';
			key: string;
			requestId: string;
			toolCall: Json;
			options: PermissionOption[];
			resolved: boolean;
			optionId: string | null;
			at: number;
	  }
	| { kind: 'turn_end'; key: string; stopReason: string | null; at: number }
	| { kind: 'error'; key: string; message: string; at: number };

function textOf(c: Json): string {
	if (!c) return '';
	if (typeof c === 'string') return c;
	if (c.type === 'text') return c.text ?? '';
	if (c.type === 'resource_link') return `[${c.name ?? c.uri}](${c.uri})`;
	if (c.type === 'resource') return c.resource?.text ?? '';
	return '';
}

function toolContent(list: Json[] | undefined): ToolContent[] {
	const out: ToolContent[] = [];
	for (const c of list ?? []) {
		if (c?.type === 'content') out.push({ type: 'text', text: textOf(c.content) });
		else if (c?.type === 'diff') out.push({ type: 'diff', path: c.path, oldText: c.oldText ?? null, newText: c.newText ?? '' });
		else if (c?.type === 'terminal') out.push({ type: 'terminal', terminalId: c.terminalId });
		else out.push({ type: 'other', value: c });
	}
	return out;
}

/** Incrementally folds ACP `session/update` events into a chat timeline. */
export class Timeline {
	items: Item[] = $state([]);
	lastSeq = 0;
	epoch = 0;
	private tools = new Map<string, Item & { kind: 'tool' }>();
	private perms = new Map<string, Item & { kind: 'permission' }>();
	private plan: (Item & { kind: 'plan' }) | null = null;

	reset(epoch: number) {
		this.items = [];
		this.lastSeq = 0;
		this.epoch = epoch;
		this.tools.clear();
		this.perms.clear();
		this.plan = null;
	}

	private last() {
		return this.items[this.items.length - 1];
	}

	apply(ev: SessionEvent) {
		if (ev.seq <= this.lastSeq) return;
		this.lastSeq = ev.seq;
		const u = ev.update ?? {};
		const at = ev.at;
		const key = `e${ev.seq}`;
		switch (u.sessionUpdate) {
			case 'user_message_chunk': {
				const parts: Json[] = u._content ?? [u.content];
				const text = parts.map(textOf).join('');
				const images = parts.filter((p) => p?.type === 'image').length;
				const last = this.last();
				if (last?.kind === 'user' && !u._local) {
					last.text += text;
					last.images += images;
				} else this.items.push({ kind: 'user', key, text, images, at });
				this.plan = null;
				break;
			}
			case 'agent_message_chunk': {
				const last = this.last();
				if (last?.kind === 'agent') last.text += textOf(u.content);
				else this.items.push({ kind: 'agent', key, text: textOf(u.content), at });
				break;
			}
			case 'agent_thought_chunk': {
				const last = this.last();
				if (last?.kind === 'thought') last.text += textOf(u.content);
				else this.items.push({ kind: 'thought', key, text: textOf(u.content), at });
				break;
			}
			case 'tool_call': {
				const existing = this.tools.get(u.toolCallId);
				if (existing) Object.assign(existing, this.toolPatch(u));
				else this.addTool(u, key, at);
				break;
			}
			case 'tool_call_update': {
				const t = this.tools.get(u.toolCallId);
				if (t) Object.assign(t, this.toolPatch(u));
				else this.addTool(u, key, at);
				break;
			}
			case 'plan': {
				const entries = u.entries ?? [];
				if (this.plan) this.plan.entries = entries;
				else {
					this.items.push({ kind: 'plan', key, entries, at });
					this.plan = this.items[this.items.length - 1] as Item & { kind: 'plan' };
				}
				break;
			}
			case '_permission_request': {
				this.items.push({
					kind: 'permission',
					key,
					requestId: u.requestId,
					toolCall: u.toolCall,
					options: u.options ?? [],
					resolved: false,
					optionId: null,
					at
				});
				this.perms.set(u.requestId, this.items[this.items.length - 1] as Item & { kind: 'permission' });
				break;
			}
			case '_permission_resolved': {
				const p = this.perms.get(u.requestId);
				if (p) {
					p.resolved = true;
					p.optionId = u.optionId ?? null;
				}
				break;
			}
			case '_turn_end':
				for (const p of this.perms.values()) p.resolved = true;
				this.items.push({ kind: 'turn_end', key, stopReason: u.stopReason ?? null, at });
				this.plan = null;
				break;
			case '_turn_error':
				for (const p of this.perms.values()) p.resolved = true;
				this.items.push({ kind: 'error', key, message: u.message ?? 'Error', at });
				this.plan = null;
				break;
		}
	}

	markPermissionResolved(requestId: string, optionId: string | null) {
		const p = this.perms.get(requestId);
		if (p) {
			p.resolved = true;
			p.optionId = optionId;
		}
	}

	private addTool(u: Json, key: string, at: number) {
		this.items.push({
			kind: 'tool',
			key,
			toolCallId: u.toolCallId,
			title: u.title ?? 'Tool call',
			toolKind: u.kind ?? 'other',
			status: u.status ?? 'pending',
			content: toolContent(u.content),
			locations: u.locations ?? [],
			rawInput: u.rawInput,
			rawOutput: u.rawOutput,
			at
		});
		this.tools.set(u.toolCallId, this.items[this.items.length - 1] as Item & { kind: 'tool' });
	}

	private toolPatch(u: Json) {
		const patch: Json = {};
		if (u.title != null) patch.title = u.title;
		if (u.kind != null) patch.toolKind = u.kind;
		if (u.status != null) patch.status = u.status;
		if (u.content != null) patch.content = toolContent(u.content);
		if (u.locations != null) patch.locations = u.locations;
		if (u.rawInput !== undefined) patch.rawInput = u.rawInput;
		if (u.rawOutput !== undefined) patch.rawOutput = u.rawOutput;
		return patch;
	}
}
