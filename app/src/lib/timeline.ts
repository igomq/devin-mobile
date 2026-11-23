// Folds the gateway's raw ACP session updates into the flat item list the chat renders:
// user / assistant / thought / tool / plan / notice.
import { base64Bytes, decodeText } from './textfile.ts';
import type { AttachedFile, Item, Json, PendingPermission, PermissionView, SessionState, SessionSummary, SessionView, ToolContent, ToolItem } from './types.ts';

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

/** A text file embedded in a prompt (ACP `resource`), or the gateway's inline fallback for one. */
export function fileOf(c: Json): AttachedFile | null {
  if (c?._file) return { name: String(c._file.name), mimeType: String(c._file.mimeType), text: String(c._file.text) };
  if (c?.type !== 'resource' || !c.resource) return null;
  const r = c.resource;
  const mimeType = String(r.mimeType || 'text/plain');
  let text: string | null = typeof r.text === 'string' ? r.text : null;
  if (text === null && typeof r.blob === 'string' && /^text\/|json|yaml|markdown/.test(mimeType)) text = decodeText(base64Bytes(r.blob));
  if (text === null) return null;
  const raw = String(r.uri ?? '').split(/[\/]/).pop() || 'file';
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    /* keep the raw name */
  }
  return { name, mimeType, text };
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
  return { status: 'idle', title: null, mode: null, modes: [], configOptions: [], commands: [], permissions: [], lastStop: null, updatedAt: null, context: null, tokens: null, turnStats: null };
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
    updatedAt: s.updatedAt ?? null,
    context: typeof s.usage?.used === 'number' && typeof s.usage?.size === 'number' && s.usage.size > 0 ? { used: s.usage.used, size: s.usage.size } : null,
    tokens: s.tokens ?? null,
    turnStats: s.turnStats ?? null,
    folderMissing: !!s.folderMissing
  };
}

export function permissionView(p: Pick<PendingPermission, 'requestId' | 'toolCall' | 'options'>, view: SessionView): PermissionView {
  const tc = p.toolCall ?? {};
  // Devin CLI's request names only the tool call; what it will run or change is on the tool call it sent just before.
  const known = view.items[view.tools[tc.toolCallId]] as ToolItem | undefined;
  const editable = tc._meta?.['cognition.ai/editableCommand'];
  return {
    reqId: p.requestId,
    toolCallId: tc.toolCallId ?? null,
    title: tc.title ?? known?.title ?? 'Permission requested',
    toolKind: tc.kind ?? known?.toolKind ?? 'other',
    content: toolContent(tc.content) ?? known?.content ?? [],
    rawInput: tc.rawInput ?? known?.rawInput ?? (editable ? { command: editable } : null),
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
        const files = parts.map(fileOf).filter((f): f is AttachedFile => !!f);
        const text = textOf(parts.filter((c) => c?.type !== 'image' && !fileOf(c)));
        add(view, { kind: 'user', text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }, ts);
        break;
      }
      // Devin CLI tags each replayed message; without the tag, prompts sent back to back would merge into one bubble.
      const messageId = u._meta?.['cognition.ai/clientMessageId'] ?? u._meta?.['cognition.ai/eventId'];
      const last = view.items[view.items.length - 1];
      const file = fileOf(u.content);
      if (file) {
        if (last?.kind === 'user' && (!messageId || last.messageId === messageId)) (last.files ??= []).push(file);
        else add(view, { kind: 'user', text: '', messageId, files: [file] }, ts);
        break;
      }
      if (messageId && !(last?.kind === 'user' && last.messageId === messageId)) add(view, { kind: 'user', text: textOf(u.content), messageId }, ts);
      else appendText(view, 'user', textOf(u.content), ts);
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
      const entries = (u.entries ?? []).map((e: Json) => ({ content: e.content, status: e.status ?? 'pending', priority: e.priority ?? 'medium' }));
      // ACP sends the whole plan each time: update this turn's plan card instead of stacking copies.
      let last: Item | undefined;
      for (let j = view.items.length - 1; j >= 0; j--) {
        const it = view.items[j];
        if (it.kind === 'plan') {
          last = it;
          break;
        }
        if (it.kind === 'user') break;
      }
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
