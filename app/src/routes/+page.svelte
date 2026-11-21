<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import StatusDot from '#lib/components/StatusDot.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import { app, baseName, relTime, shortPath } from '#lib/app.svelte.ts';
	import type { Project } from '#lib/types.ts';
	import { onMount } from 'svelte';

	let pickerOpen = $state(false);
	let projects = $state<Project[]>([]);
	let browsePath = $state<string | null>(null);
	let browseDirs = $state<{ name: string; path: string; isGit: boolean }[]>([]);
	let browseParent = $state<string | null>(null);
	let creating = $state<string | null>(null);
	let filter = $state<string | null>(null);

	onMount(() => {
		if (!app.configured) goto('/settings', { replaceState: true });
	});

	$effect(() => {
		if (app.conn === 'open' && !app.sessionsLoaded) app.refreshSessions();
	});

	const sessions = $derived(
		Object.values(app.sessions)
			.filter((s) => !filter || s.cwd === filter)
			.sort((a, b) => {
				const pa = a.status === 'awaiting_permission' ? 2 : a.status === 'running' ? 1 : 0;
				const pb = b.status === 'awaiting_permission' ? 2 : b.status === 'running' ? 1 : 0;
				return pb - pa || b.updatedAt - a.updatedAt;
			})
	);
	const projectChips = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const s of Object.values(app.sessions)) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
	});
	const active = $derived(Object.values(app.sessions).filter((s) => s.status === 'running' || s.status === 'awaiting_permission').length);

	async function openPicker() {
		pickerOpen = true;
		browsePath = null;
		try {
			const r = await app.req<{ projects: Project[] }>('projects.list');
			projects = r.projects;
		} catch (e) {
			app.showError(e);
		}
	}

	async function browse(path: string) {
		try {
			const r = await app.req<{ path: string; parent: string | null; entries: { name: string; path: string; isGit: boolean }[] }>('fs.listDirs', { path });
			browsePath = r.path;
			browseParent = r.parent;
			browseDirs = r.entries;
		} catch (e) {
			app.showError(e);
		}
	}

	async function start(cwd: string) {
		creating = cwd;
		try {
			const id = await app.createSession(cwd);
			pickerOpen = false;
			goto(`/session?id=${encodeURIComponent(id)}`);
		} catch (e) {
			app.showError(e);
		} finally {
			creating = null;
		}
	}

	const recent = $derived(app.recentProjects);
	const sortedProjects = $derived(
		[...projects].sort((a, b) => {
			const ra = recent.indexOf(a.path);
			const rb = recent.indexOf(b.path);
			return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.name.localeCompare(b.name);
		})
	);
</script>

<div class="screen">
	<header class="topbar">
		<div class="topbar-row">
			<button class="host" onclick={() => goto('/settings')}>
				<span class="conn {app.conn}"></span>
				<span class="hn">{app.hostname ?? 'Devin'}</span>
				<Icon name="down" size={14} />
			</button>
			<span class="spacer"></span>
			<button class="icon-btn" aria-label="Terminal" onclick={() => goto('/terminal')}><Icon name="terminal" /></button>
			<button class="icon-btn" aria-label="Settings" onclick={() => goto('/settings')}><Icon name="settings" /></button>
		</div>
	</header>

	<main>
		<div class="heading">
			<h1>Sessions</h1>
			{#if active}<span class="active">{active} active</span>{/if}
		</div>

		{#if projectChips.length > 1}
			<div class="chips">
				<button class="chip" class:on={!filter} onclick={() => (filter = null)}>All</button>
				{#each projectChips as cwd (cwd)}
					<button class="chip" class:on={filter === cwd} onclick={() => (filter = filter === cwd ? null : cwd)}>{baseName(cwd)}</button>
				{/each}
			</div>
		{/if}

		{#if !app.sessionsLoaded && app.conn !== 'open'}
			<div class="empty"><span class="spinner"></span></div>
		{:else if sessions.length === 0}
			<div class="empty">
				<p>No sessions yet.</p>
				<p class="muted">Start one in a project directory on your VM.</p>
			</div>
		{:else}
			<div class="list">
				{#each sessions as s (s.sessionId)}
					<button class="row session" onclick={() => goto(`/session?id=${encodeURIComponent(s.sessionId)}`)}>
						<div class="main">
							<div class="title">{s.title || 'Untitled session'}</div>
							<div class="sub">
								<span class="proj">{baseName(s.cwd)}</span>
								{#if s.status === 'awaiting_permission'}<span class="warn">· Needs approval</span>{:else if s.status === 'running'}<span class="run">· Working</span>{:else if s.status === 'error'}<span class="errt">· Error</span>{/if}
							</div>
						</div>
						<div class="meta">
							<span class="time">{relTime(s.updatedAt)}</span>
							<StatusDot status={s.status} />
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</main>

	<div class="fab-wrap">
		<button class="fab" onclick={openPicker} disabled={app.conn !== 'open'}>
			<Icon name="edit" size={18} />
			New session
		</button>
	</div>
</div>

<Sheet bind:open={pickerOpen} title={browsePath ? shortPath(browsePath, app.home) : 'Choose a project'}>
	{#if browsePath}
		<div class="list">
			<div class="browse-actions">
				{#if browseParent}<button class="btn small" onclick={() => browse(browseParent!)}><Icon name="back" size={14} /> Up</button>{/if}
				<span class="spacer"></span>
				<button class="btn small primary" disabled={!!creating} onclick={() => start(browsePath!)}>
					{#if creating === browsePath}<span class="spinner"></span>{/if}
					Start here
				</button>
			</div>
			{#each browseDirs as d (d.path)}
				<button class="row" onclick={() => browse(d.path)}>
					<Icon name={d.isGit ? 'git' : 'folder'} size={18} />
					<div class="main"><div class="title">{d.name}</div></div>
					<Icon name="chevron" size={16} />
				</button>
			{/each}
			{#if !browseDirs.length}<div class="empty">No subdirectories</div>{/if}
		</div>
	{:else}
		<div class="list">
			{#each sortedProjects as p (p.path)}
				<button class="row" disabled={!!creating} onclick={() => start(p.path)}>
					<Icon name={p.isGit ? 'git' : 'folder'} size={18} />
					<div class="main">
						<div class="title">{p.name}</div>
						<div class="sub mono">{shortPath(p.path, app.home)}</div>
					</div>
					{#if creating === p.path}<span class="spinner"></span>{/if}
				</button>
			{/each}
			<button class="row" onclick={() => browse(app.home ?? '/')}>
				<Icon name="search" size={18} />
				<div class="main"><div class="title">Browse folders…</div></div>
				<Icon name="chevron" size={16} />
			</button>
		</div>
	{/if}
</Sheet>

<style>
	main {
		flex: 1;
		padding-bottom: calc(96px + var(--safe-bottom));
		max-width: 760px;
		width: 100%;
		margin: 0 auto;
	}
	.host {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-radius: 12px;
		font-weight: 600;
	}
	.host:active {
		background: var(--bg-elev-2);
	}
	.hn {
		max-width: 52vw;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.conn {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-3);
	}
	.conn.open {
		background: var(--green);
	}
	.conn.connecting {
		background: var(--amber);
		animation: pulse 1s infinite;
	}
	.conn.auth_failed,
	.conn.closed {
		background: var(--red);
	}
	.heading {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 8px 16px 4px;
	}
	h1 {
		font-size: 28px;
		letter-spacing: -0.02em;
		margin: 0;
	}
	.active {
		font-size: 13px;
		color: var(--blue);
		font-weight: 500;
	}
	.chips {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		padding: 10px 16px 6px;
		scrollbar-width: none;
	}
	.chip {
		flex: none;
		padding: 6px 12px;
		border-radius: 999px;
		border: 1px solid var(--border);
		font-size: 13.5px;
		color: var(--text-2);
	}
	.chip.on {
		background: var(--accent);
		color: var(--accent-text);
		border-color: var(--accent);
	}
	.session {
		border-bottom: 1px solid var(--border);
		min-height: 66px;
	}
	.session .title {
		font-size: 15.5px;
	}
	.sub .proj {
		color: var(--text-2);
	}
	.warn {
		color: var(--amber);
	}
	.run {
		color: var(--blue);
	}
	.errt {
		color: var(--red);
	}
	.meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
		flex: none;
	}
	.time {
		font-size: 12.5px;
		color: var(--text-3);
	}
	.fab-wrap {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 16px 16px calc(16px + var(--safe-bottom));
		display: flex;
		justify-content: center;
		background: linear-gradient(to bottom, transparent, var(--bg) 40%);
		pointer-events: none;
	}
	.fab {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 50px;
		padding: 0 22px;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-text);
		font-weight: 600;
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
	}
	.fab:disabled {
		opacity: 0.4;
	}
	.browse-actions {
		display: flex;
		gap: 8px;
		padding: 4px 16px 8px;
	}
</style>
