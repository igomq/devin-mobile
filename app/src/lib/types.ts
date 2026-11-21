export type Json = any;

export type SessionStatus = 'idle' | 'running' | 'awaiting_permission' | 'error' | 'unloaded';

export interface ConfigOptionValue {
	value: string;
	name: string;
	description?: string | null;
}
export interface ConfigOption {
	id: string;
	name: string;
	description?: string | null;
	category?: string | null;
	type: 'select' | string;
	currentValue: string | boolean;
	options?: (ConfigOptionValue | { group: string; name: string; options: ConfigOptionValue[] })[];
}

export interface SessionSummary {
	sessionId: string;
	cwd: string;
	title: string | null;
	status: SessionStatus;
	loaded: boolean;
	updatedAt: number;
	lastStopReason: string | null;
	lastError: string | null;
	pendingPermissions: number;
	configOptions: ConfigOption[];
	modes: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] } | null;
	commands: { name: string; description?: string; input?: { hint?: string } | null }[];
	usage: Json | null;
}

export interface SessionEvent {
	seq: number;
	at: number;
	update: Json;
}

export interface PermissionOption {
	optionId: string;
	name: string;
	kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface PendingPermission {
	requestId: string;
	toolCall: Json;
	options: PermissionOption[];
	at: number;
}

export interface Project {
	path: string;
	name: string;
	isGit: boolean;
}

export interface ChangedFile {
	path: string;
	oldPath?: string;
	index: string;
	worktree: string;
	status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
	additions: number;
	deletions: number;
	binary: boolean;
}

export interface GitStatus {
	isRepo: boolean;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	head: string | null;
	files: ChangedFile[];
}

export interface TaskRun {
	taskId: string;
	cwd: string;
	command: string;
	startedAt: number;
	endedAt: number | null;
	exitCode: number | null;
	output?: string;
	truncated: boolean;
}

export interface TerminalInfo {
	termId: string;
	cwd: string;
	command: string;
	title: string;
	startedAt: number;
	exited: boolean;
	exitCode: number | null;
}

export interface AgentStatus {
	running: boolean;
	error: string | null;
	agentInfo: { name?: string; title?: string; version?: string } | null;
	authMethods: { id: string; name: string; description?: string }[];
}

/* What the screens render, folded from the gateway's raw ACP updates. */

export type ToolContent =
	| { type: 'text'; text: string }
	| { type: 'diff'; path: string; oldText: string | null; newText: string }
	| { type: 'terminal'; terminalId: string };

interface ItemBase {
	id: string;
	ts: number;
}
export interface TextItem extends ItemBase {
	kind: 'user' | 'assistant' | 'thought';
	text: string;
	images?: { mimeType: string; data: string }[];
}
export interface ToolItem extends ItemBase {
	kind: 'tool';
	toolCallId: string;
	title: string;
	toolKind: string;
	status: 'pending' | 'in_progress' | 'completed' | 'failed' | string;
	content: ToolContent[];
	locations: { path: string; line?: number | null }[];
	rawInput: Json;
	rawOutput: Json;
}
export interface PlanItem extends ItemBase {
	kind: 'plan';
	entries: { content: string; status: string; priority: string }[];
}
export interface NoticeItem extends ItemBase {
	kind: 'notice';
	level: 'info' | 'warn' | 'error';
	text: string;
}
export type Item = TextItem | ToolItem | PlanItem | NoticeItem;

export interface PermissionView {
	reqId: string;
	toolCallId: string | null;
	title: string;
	toolKind: string;
	content: ToolContent[];
	rawInput: Json;
	options: PermissionOption[];
}

export interface SlashCommand {
	name: string;
	description: string;
	hint: string | null;
	category: string | null;
}

export interface SessionState {
	status: Exclude<SessionStatus, 'unloaded'>;
	title: string | null;
	mode: string | null;
	modes: { id: string; name: string; description?: string }[];
	configOptions: ConfigOption[];
	commands: SlashCommand[];
	permissions: PermissionView[];
	lastStop: string | null;
	updatedAt: number | null;
}

export interface SessionView {
	epoch: string | number | null;
	seq: number;
	cwd: string | null;
	items: Item[];
	/** toolCallId -> index in `items` */
	tools: Record<string, number>;
	state: SessionState;
	ready: boolean;
	error: string | null;
	truncated: boolean;
}

/** One row of the home screen's session list. */
export interface SessionRow {
	id: string;
	cwd: string | null;
	title: string | null;
	updatedAt: number | string | null;
	status: Exclude<SessionStatus, 'unloaded'>;
	hasMessages: boolean;
}

export interface DiffRow {
	type: 'hunk' | 'add' | 'del' | 'ctx' | 'meta';
	text: string;
	a?: number;
	b?: number;
}

export interface ChangedFileView {
	path: string;
	kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'conflict';
	added: number | null;
	removed: number | null;
}

export interface ConnInfo {
	host: string;
	home: string;
	version: string;
	agent: AgentStatus | null;
}
