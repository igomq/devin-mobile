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
	harnessId?: string;
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
	tokens?: TokenTotals;
	turnStats?: TurnStat[] | null;
}

export interface TokenTotals {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cachedReadTokens: number;
}

export interface TurnStat {
	id: string;
	group: string | null;
	label: string;
	value: string | number;
}

/** ACP `usage_update`: context window use. */
export interface ContextUsage {
	used: number;
	size: number;
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
	/** The agent's id for this message, when it gives one. */
	messageId?: string;
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
	context: ContextUsage | null;
	tokens: TokenTotals | null;
	turnStats: TurnStat[] | null;
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
	harnessId?: string;
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

export interface HarnessCapabilities {
	acp: boolean;
	acpVersion: number | null;
	streaming: boolean;
	models: boolean;
	reasoningLevels: boolean;
	modes: boolean;
	permissions: boolean;
	mcp: boolean;
	sessionResume: boolean;
	sessionClose: boolean;
	sessionDelete: boolean;
	subagents: boolean;
	usage: boolean;
}

export interface HarnessInfo {
	id: string;
	name: string;
	version: string | null;
	bin: string;
	installed: boolean;
	enabled: boolean;
	custom: boolean;
	authStatus: 'authenticated' | 'unauthenticated' | 'unknown';
	authMethod: string | null;
	acpSupported: boolean;
	acpVersion: number | null;
	capabilities: HarnessCapabilities;
	models: { id: string; name: string; description?: string; reasoningLevels?: string[]; default?: boolean }[];
	status: 'idle' | 'starting' | 'ready' | 'error' | 'disabled';
	error: string | null;
	installHint: string | null;
}

export interface WorkspaceSessionRef {
	harnessId: string;
	sessionId: string;
	title: string | null;
	updatedAt: number;
}

export interface Workspace {
	workspaceId: string;
	name: string;
	cwd: string;
	repoRoot: string | null;
	branch: string | null;
	activeHarnessId: string | null;
	activeSessionId: string | null;
	sessions: WorkspaceSessionRef[];
	createdAt: number;
	updatedAt: number;
}

export interface ConnInfo {
	host: string;
	home: string;
	version: string;
	agent: AgentStatus | null;
	harnesses?: HarnessInfo[];
	workspaces?: Workspace[];
	notifications?: { unreadCount: number; lastSeq: number } | null;
}

export type NotificationEventType =
	| 'approval_requested'
	| 'task_completed'
	| 'execution_failed'
	| 'subagent_completed'
	| 'git_conflict'
	| 'gateway_disconnected'
	| 'attention_needed';

export interface AppNotification {
	id: string;
	seq: number;
	type: NotificationEventType;
	severity: 'info' | 'success' | 'warning' | 'error';
	title: string;
	body: string;
	safeBody: string;
	sessionId: string | null;
	harnessId: string | null;
	route: string | null;
	dedupKey: string;
	at: number;
	read: boolean;
	/** Raised by this device (e.g. it lost the gateway), not by the gateway. */
	local?: boolean;
}

export interface NotificationPrefs {
	enabled: boolean;
	inApp: boolean;
	webPush: boolean;
	hideSensitiveDetails: boolean;
	dedupWindowMs: number;
	attentionTimeoutMs: number;
	events: Record<NotificationEventType, boolean>;
}

export interface PlatformCapability {
	status: 'available' | 'requires_secure_context' | 'requires_external_setup' | 'blocked_by_signing';
	background: boolean;
	detail: string;
}

export type NotificationCapabilities = Record<'inApp' | 'webPush' | 'androidFcm' | 'iosApns', PlatformCapability>;
