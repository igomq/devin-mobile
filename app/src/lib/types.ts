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
