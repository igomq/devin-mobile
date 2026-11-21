<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import DiffLines from '#lib/components/DiffLines.svelte';
	import { app, baseName } from '#lib/app.svelte.ts';
	import { parseUnified, type FileDiff } from '#lib/diff.ts';
	import type { ChangedFile, GitStatus, TaskRun } from '#lib/types.ts';

	const cwd = $derived(page.url.searchParams.get('cwd') ?? '');
	const sessionId = $derived(page.url.searchParams.get('session'));
	let tab = $state<'files' | 'tests'>(page.url.searchParams.get('tab') === 'tests' ? 'tests' : 'files');

	let st = $state<GitStatus | null>(null);
	let loading = $state(false);
	let err = $state<string | null>(null);
	let selected = $state<string | null>(null);
	let fileDiff = $state<FileDiff | null>(null);
	let diffLoading = $state(false);
	let diffTruncated = $state(false);

	let command = $state('');
	let tasks = $state<TaskRun[]>([]);
	let current = $state<TaskRun | null>(null);
	let output = $state('');
	let outEl = $state<HTMLElement>();

	async function refresh() {
		if (!cwd || app.conn !== 'open') return;
		loading = true;
		err = null;
		try {
			st = await app.req<GitStatus>('git.status', { cwd }, 30000);
		} catch (e: any) {
			err = e.message;
		} finally {
			loading = false;
		}
	}

	async function openFile(f: ChangedFile) {
		selected = f.path;
		fileDiff = null;
		diffLoading = true;
		try {
			const r = await app.req<{ diff: string; truncated: boolean }>('git.diff', { cwd, path: f.path }, 30000);
			const files = parseUnified(r.diff);
			fileDiff = files.find((x) => x.path === f.path) ?? files[0] ?? { path: f.path, oldPath: null, lines: [], binary: f.binary, additions: 0, deletions: 0 };
			diffTruncated = r.truncated;
		} catch (e) {
			app.showError(e);
			selected = null;
		} finally {
			diffLoading = false;
		}
	}

	async function loadTasks() {
		try {
			const [d, l] = await Promise.all([
				app.req<{ command: string | null }>('tasks.detect', { cwd }),
				app.req<{ tasks: TaskRun[] }>('tasks.list', { cwd })
			]);
			if (!command) command = d.command ?? '';
			tasks = l.tasks;
			if (!current && tasks[0]) await showTask(tasks[0].taskId);
		} catch (e) {
			app.showError(e);
		}
	}

	async function showTask(taskId: string) {
		const r = await app.req<{ task: TaskRun }>('tasks.get', { taskId });
		current = r.task;
		output = r.task.output ?? '';
		queueMicrotask(() => outEl?.scrollTo({ top: outEl.scrollHeight }));
	}

	async function runTests() {
		try {
			const r = await app.req<{ task: TaskRun }>('tasks.run', { cwd, command });
			current = r.task;
			output = '';
			tasks = [r.task, ...tasks];
		} catch (e) {
			app.showError(e);
		}
	}

	async function stopTask() {
		if (current) await app.req('tasks.stop', { taskId: current.taskId }).catch((e) => app.showError(e));
	}

	function sendResults() {
		if (!current || !sessionId) return;
		const tail = output.slice(-6000);
		const text = `I ran \`${current.command}\` and it exited with code ${current.exitCode}. Please fix the failures.\n\n\`\`\`\n${tail}\n\`\`\``;
		app.req('session.prompt', { sessionId, text }).then(() => goto(`/session?id=${encodeURIComponent(sessionId)}`)).catch((e) => app.showError(e));
	}

	const offs: (() => void)[] = [];
	$effect(() => {
		const c = app.client;
		if (!c) return;
		const a = c.on('task_output', (m) => {
			if (current && m.taskId === current.taskId) {
				output += m.chunk;
				if (outEl && outEl.scrollHeight - outEl.scrollTop - outEl.clientHeight < 60) queueMicrotask(() => outEl?.scrollTo({ top: outEl.scrollHeight }));
			}
		});
		const b = c.on('task_done', (m) => {
			tasks = tasks.map((t) => (t.taskId === m.task.taskId ? m.task : t));
			if (current?.taskId === m.task.taskId) current = { ...current, ...m.task };
			if (tab === 'files') refresh();
		});
		offs.push(a, b);
		return () => {
			a();
			b();
		};
	});
	onDestroy(() => offs.forEach((f) => f()));

	$effect(() => {
		if (app.conn === 'open' && cwd) {
			refresh();
			loadTasks();
		}
	});

	// refresh git status when the agent finishes a turn
	$effect(() => {
		const s = sessionId ? app.sessions[sessionId] : null;
		if (s && s.status === 'idle') refresh();
	});

	const totals = $derived(st ? st.files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 }) : { add: 0, del: 0 });
	const letter: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!' };
	const running = $derived(current && current.exitCode === null && current.endedAt === null);
</script>

<div class="screen">
	<header class="topbar bordered">
		<div class="topbar-row">
			<button class="icon-btn" aria-label="Back" onclick={() => (selected ? (selected = null) : history.length > 1 ? history.back() : goto('/'))}><Icon name="back" /></button>
			<div class="topbar-title">
				<span class="t">{selected ? baseName(selected) : 'Changes'}</span>
				<span class="s mono">{selected ?? `${baseName(cwd)}${st?.branch ? ` · ${st.branch}` : ''}`}</span>
			</div>
			<button class="icon-btn" aria-label="Refresh" onclick={() => (selected && st ? openFile(st.files.find((f) => f.path === selected)!) : refresh())}>
				{#if loading || diffLoading}<span class="spinner"></span>{:else}<Icon name="refresh" size={18} />{/if}
			</button>
		</div>
		{#if !selected}
			<div class="tabs">
				<button class:on={tab === 'files'} onclick={() => (tab = 'files')}>Files {#if st?.files.length}<span class="count">{st.files.length}</span>{/if}</button>
				<button class:on={tab === 'tests'} onclick={() => (tab = 'tests')}>Tests {#if current?.exitCode != null}<span class="dot {current.exitCode === 0 ? 'ok' : 'bad'}"></span>{/if}</button>
			</div>
		{/if}
	</header>

	{#if selected}
		<main class="diffview">
			{#if diffLoading}
				<div class="empty"><span class="spinner"></span></div>
			{:else if fileDiff?.binary}
				<div class="empty">Binary file</div>
			{:else if fileDiff && fileDiff.lines.length}
				<div class="dstat"><span class="a">+{fileDiff.additions}</span> <span class="d">-{fileDiff.deletions}</span>{#if fileDiff.oldPath && fileDiff.oldPath !== fileDiff.path}<span class="muted mono"> · from {fileDiff.oldPath}</span>{/if}</div>
				<DiffLines lines={fileDiff.lines} />
				{#if diffTruncated}<div class="empty">Diff truncated</div>{/if}
			{:else}
				<div class="empty">No textual changes</div>
			{/if}
		</main>
	{:else if tab === 'files'}
		<main>
			{#if err}
				<div class="empty">{err}</div>
			{:else if st && !st.isRepo}
				<div class="empty">Not a git repository</div>
			{:else if st}
				<div class="summary">
					<span>{st.files.length} changed file{st.files.length === 1 ? '' : 's'}</span>
					<span class="mono"><span class="a">+{totals.add}</span> <span class="d">-{totals.del}</span></span>
					{#if st.ahead || st.behind}<span class="muted">↑{st.ahead} ↓{st.behind}</span>{/if}
				</div>
				{#if !st.files.length}
					<div class="empty">Working tree clean</div>
				{/if}
				<div class="list">
					{#each st.files as f (f.path)}
						<button class="row file" onclick={() => openFile(f)}>
							<span class="badge {f.status}">{letter[f.status]}</span>
							<div class="main">
								<div class="title mono">{baseName(f.path)}</div>
								<div class="sub mono">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.'}</div>
							</div>
							<span class="mono small">{#if f.binary}<span class="muted">bin</span>{:else}<span class="a">+{f.additions}</span> <span class="d">-{f.deletions}</span>{/if}</span>
						</button>
					{/each}
				</div>
			{:else}
				<div class="empty"><span class="spinner"></span></div>
			{/if}
		</main>
	{:else}
		<main class="tests">
			<div class="runbar">
				<input class="input mono" bind:value={command} placeholder="npm test" autocapitalize="off" autocorrect="off" spellcheck="false" />
				{#if running}
					<button class="btn danger" onclick={stopTask}>Stop</button>
				{:else}
					<button class="btn primary" disabled={!command.trim()} onclick={runTests}><Icon name="run" size={16} /> Run</button>
				{/if}
			</div>
			{#if current}
				<div class="result">
					<span class="state {running ? 'run' : current.exitCode === 0 ? 'ok' : 'bad'}">
						{#if running}<span class="spinner"></span> Running{:else if current.exitCode === 0}<Icon name="check" size={14} stroke={2.5} /> Passed{:else}<Icon name="x" size={14} stroke={2.5} /> Failed (exit {current.exitCode}){/if}
					</span>
					<span class="muted mono cmdtxt">{current.command}</span>
					{#if !running && current.exitCode !== 0 && sessionId}
						<button class="btn small" onclick={sendResults}>Ask Devin to fix</button>
					{/if}
				</div>
				<pre class="output" bind:this={outEl}>{output || (running ? '' : '(no output)')}</pre>
			{:else}
				<div class="empty">Run the project's tests and review results here.</div>
			{/if}
			{#if tasks.length > 1}
				<div class="section-label">History</div>
				<div class="list">
					{#each tasks.slice(0, 10) as t (t.taskId)}
						<button class="row" onclick={() => showTask(t.taskId)}>
							<span class="dot {t.exitCode == null ? 'run' : t.exitCode === 0 ? 'ok' : 'bad'}"></span>
							<div class="main"><div class="title mono small">{t.command}</div><div class="sub">{new Date(t.startedAt).toLocaleTimeString()}</div></div>
						</button>
					{/each}
				</div>
			{/if}
		</main>
	{/if}
</div>

<style>
	main {
		max-width: 900px;
		width: 100%;
		margin: 0 auto;
		padding-bottom: calc(24px + var(--safe-bottom));
	}
	.tabs {
		display: flex;
		gap: 4px;
		padding: 0 12px 8px;
	}
	.tabs button {
		flex: 1;
		height: 34px;
		border-radius: 10px;
		color: var(--text-2);
		font-weight: 500;
		font-size: 14px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
	}
	.tabs button.on {
		background: var(--bg-elev-2);
		color: var(--text);
	}
	.count {
		font-size: 12px;
		background: var(--border-strong);
		padding: 0 6px;
		border-radius: 999px;
	}
	.summary {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 14px 16px 6px;
		font-size: 14px;
		color: var(--text-2);
	}
	.a {
		color: var(--green);
	}
	.d {
		color: var(--red);
	}
	.file {
		min-height: 52px;
		padding-top: 8px;
		padding-bottom: 8px;
	}
	.file .title {
		font-size: 14px;
	}
	.file .sub {
		font-size: 12px;
	}
	.small {
		font-size: 12.5px;
	}
	.badge {
		width: 22px;
		height: 22px;
		border-radius: 6px;
		font-size: 12px;
		font-weight: 700;
		font-family: var(--mono);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		background: var(--amber-bg);
		color: var(--amber);
	}
	.badge.added,
	.badge.untracked {
		background: var(--green-bg);
		color: var(--green);
	}
	.badge.deleted,
	.badge.conflict {
		background: var(--red-bg);
		color: var(--red);
	}
	.badge.renamed {
		background: var(--blue-bg);
		color: var(--blue);
	}
	.diffview {
		max-width: none;
	}
	.dstat {
		padding: 10px 16px;
		font-family: var(--mono);
		font-size: 13px;
		border-bottom: 1px solid var(--border);
	}
	.tests {
		padding: 12px 16px calc(24px + var(--safe-bottom));
	}
	.runbar {
		display: flex;
		gap: 8px;
	}
	.result {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin: 14px 0 8px;
	}
	.state {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		font-size: 14px;
	}
	.state.ok {
		color: var(--green);
	}
	.state.bad {
		color: var(--red);
	}
	.state.run {
		color: var(--blue);
	}
	.cmdtxt {
		font-size: 12.5px;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.output {
		margin: 0;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 12px;
		font-size: 12px;
		line-height: 1.5;
		max-height: 55dvh;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
		flex: none;
	}
	.dot.ok {
		background: var(--green);
	}
	.dot.bad {
		background: var(--red);
	}
	.dot.run {
		background: var(--blue);
	}
	.tests .section-label {
		padding-left: 0;
	}
	.tests .row {
		padding-left: 0;
		padding-right: 0;
	}
</style>
