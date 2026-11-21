// Folds the gateway's raw ACP session updates into the flat item list the chat renders:
// user / assistant / thought / tool / plan / notice.
import type { Item, Json, PendingPermission, PermissionView, SessionState, SessionSummary, SessionView, ToolContent, ToolItem } from './types.ts';

function textOf(content: Json): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('');
  if (content.type === 'text') return content.text ?? '';
  if (content.type === 'resource_link') return `[${content.name || content.uri}](${content.uri})`;
  if (content.type === 'resource') return content.resource?.text ?? '';
  if (content.type === 'image') return '[image]';
  return '';
}

function toolContent(list: Json): ToolContent[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map((c): ToolContent => {
    if (c.type === 'diff') return { type: 'diff', path: c.path, oldText: c.oldText ?? null, newText: c.newText ?? '' };
    if (c.type === 'terminal') return { type: 'terminal', terminalId: c.terminalId };
    return { type: 'text', text: textOf(c.content ?? c) };
  });
}

export function emptyState(): SessionState {
  return { status: 'idle', title: null, mode: null, modes: [], configOptions: [], commands: [], permissions: [], lastStop: null, updatedAt: null };
}

/** The per-session fields the gateway reports in its session summary. */
export function stateFromSummary(s: SessionSummary): Partial<SessionState> {
  return {
    status: s.status === 'unloaded' ? 'idle' : s.status,
    title: s.title ?? null,
    mode: s.modes?.currentModeId ?? null,
    modes: s.modes?.availableModes ?? [],
    configOptions: s.configOptions ?? [],
    commands: (s.commands ?? []).map((c: Json) => ({ name: c.name, description: c.description ?? '', hint: c.input?.hint ?? null, category: c._meta?.['cognition.ai/category'] ?? null })),
    updatedAt: s.updatedAt ?? null
  };
}

export function permissionView(p: Pick<PendingPermission, 'requestId' | 'toolCall' | 'options'>, view: SessionView): PermissionView {
  const tc = p.toolCall ?? {};
  const known = view.items[view.tools[tc.toolCallId]] as ToolItem | undefined;
  return {
    reqId: p.requestId,
    toolCallId: tc.toolCallId ?? null,
    title: tc.title ?? known?.title ?? 'Permission requested',
    toolKind: tc.kind ?? known?.toolKind ?? 'other',
    content: toolContent(tc.content) ?? [],
    rawInput: tc.rawInput ?? null,
    options: (p.options ?? []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
  };
}

type Draft<T> = T extends Item ? Omit<T, 'id' | 'ts'> : never;

function add(view: SessionView, item: Draft<Item>, ts: number) {
  view.items.push({ ...item, id: `i${view.items.length + 1}`, ts } as Item);
  return view.items.length - 1;
}

function appendText(view: SessionView, kind: 'user' | 'assistant' | 'thought', text: string, ts: number) {
  if (!text) return;
  const last = view.items[view.items.length - 1];
  if (last && last.kind === kind) last.text += text;
  else add(view, { kind, text }, ts);
}

export function applyUpdate(view: SessionView, u: Json, ts = Date.now()) {
  switch (u.sessionUpdate) {
    case 'user_message_chunk': {
      // A prompt sent through the gateway is one whole message; replayed history arrives in chunks.
      if (u._local) {
        const parts: Json[] = Array.isArray(u._content) ? u._content : [u.content];
        const images = parts.filter((c) => c?.type === 'image' && c.data).map((c) => ({ mimeType: String(c.mimeType), data: String(c.data) }));
        add(view, { kind: 'user', text: textOf(parts.filter((c) => c?.type !== 'image')), ...(images.length ? { images } : {}) }, ts);
        break;
      }
      appendText(view, 'user', textOf(u.content), ts);
      break;
    }
    case 'agent_message_chunk':
      appendText(view, 'assistant', textOf(u.content), ts);
      break;
    case 'agent_thought_chunk':
      appendText(view, 'thought', textOf(u.content), ts);
      break;
    case 'tool_call':
    case 'tool_call_update': {
      let i = view.tools[u.toolCallId];
      if (i === undefined) {
        i = add(view, { kind: 'tool', toolCallId: u.toolCallId, title: 'Tool call', toolKind: 'other', status: 'pending', content: [], locations: [], rawInput: null, rawOutput: null }, ts);
        view.tools[u.toolCallId] = i;
      }
      const item = view.items[i] as ToolItem;
      if (u.title != null) item.title = u.title;
      if (u.kind != null) item.toolKind = u.kind;
      if (u.status != null) item.status = u.status;
      if (u.content != null) item.content = toolContent(u.content) ?? [];
      if (u.locations != null) item.locations = u.locations;
      if (u.rawInput != null) item.rawInput = u.rawInput;
      if (u.rawOutput != null) item.rawOutput = u.rawOutput;
      break;
    }
    case 'plan': {
      const last = view.items[view.items.length - 1];
      const entries = (u.entries ?? []).map((e: Json) => ({ content: e.content, status: e.status ?? 'pending', priority: e.priority ?? 'medium' }));
      if (last && last.kind === 'plan') last.entries = entries;
      else add(view, { kind: 'plan', entries }, ts);
      break;
    }
    case '_turn_end':
      if (u.stopReason && u.stopReason !== 'end_turn') {
        const cancelled = u.stopReason === 'cancelled';
        add(view, { kind: 'notice', level: cancelled ? 'info' : 'warn', text: cancelled ? 'Stopped.' : `Turn ended: ${u.stopReason}` }, ts);
      }
      break;
    case '_turn_error':
      add(view, { kind: 'notice', level: 'error', text: u.message ?? 'The turn failed.' }, ts);
      break;
    default:
      break;
  }
}
