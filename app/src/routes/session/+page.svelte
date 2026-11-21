<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, tick, untrack } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Markdown from '#lib/components/Markdown.svelte';
	import ToolCall from '#lib/components/ToolCall.svelte';
	import Thought from '#lib/components/Thought.svelte';
	import PlanCard from '#lib/components/PlanCard.svelte';
	import PermissionCard from '#lib/components/PermissionCard.svelte';
	import Composer from '#lib/components/Composer.svelte';
	import ConfigSheet from '#lib/components/ConfigSheet.svelte';
	import StatusDot from '#lib/components/StatusDot.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import { app, baseName, shortPath } from '#lib/app.svelte.ts';

	const id = $derived(page.url.searchParams.get('id') ?? '');
	const session = $derived(app.sessions[id]);
	const tl = $derived(app.timeline(id));
	const items = $derived(tl.items);
	const running = $derived(session?.status === 'running' || session?.status === 'awaiting_permission');
	const pending = $derived(app.permissions[id] ?? []);

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let scroller: HTMLElement;
	let stick = true;
	let showJump = $state(false);
	let configOpen = $state(false);
	let menuOpen = $state(false);

	$effect(() => {
		const sid = id;
		const open = app.conn === 'open';
		if (!sid || !open) return;
		untrack(() => {
			loading = tl.items.length === 0;
			loadError = null;
			app
				.subscribe(sid)
				.catch((e) => (loadError = String(e?.message ?? e)))
				.finally(() => {
					loading = false;
					tick().then(() => scrollToBottom(false));
				});
		});
	});

	onDestroy(() => {
		if (id) app.unsubscribe(id);
	});

	// keep pinned to bottom while streaming
	$effect(() => {
		void items.length;
		const last = items[items.length - 1];
		void (last && 'text' in last ? last.text.length : 0);
		void (last?.kind === 'tool' ? last.status : 0);
		if (stick) tick().then(() => scrollToBottom(false));
	});

	function onscroll() {
		const d = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		stick = d < 80;
		showJump = d > 400;
	}

	function scrollToBottom(smooth = true) {
		if (!scroller) return;
		scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
	}

	async function send(text: string, images: { mimeType: string; data: string }[]) {
		stick = true;
		try {
			await app.req('session.prompt', { sessionId: id, text, images }, 30000);
		} catch (e) {
			app.showError(e);
			throw e;
		}
	}

	async function stop() {
		try {
			await app.req('session.cancel', { sessionId: id });
		} catch (e) {
			app.showError(e);
		}
	}

	async function resolve(requestId: string, optionId: string | null) {
		try {
			await app.req('session.permission', { sessionId: id, requestId, optionId });
		} catch (e) {
			app.showError(e);
		}
	}

	async function closeSession() {
		menuOpen = false;
		try {
			await app.req('session.close', { sessionId: id });
			goto('/');
		} catch (e) {
			app.showError(e);
		}
	}

	async function deleteSession() {
		if (!confirm('Delete this session? Its history will be removed from the VM.')) return;
		menuOpen = false;
		try {
			await app.req('session.delete', { sessionId: id });
			goto('/', { replaceState: true });
		} catch (e) {
			app.showError(e);
		}
	}

	const lastThoughtLive = $derived(running && items[items.length - 1]?.kind === 'thought');
	const pendingIds = $derived(new Set(pending.map((p) => p.requestId)));
	const showWorking = $derived(running && !pending.length && items[items.length - 1]?.kind !== 'thought');
</script>

<div class="chat">
	<header class="topbar bordered">
		<div class="topbar-row">
			<button class="icon-btn" aria-label="Back" onclick={() => goto('/')}><Icon name="back" /></button>
			<div class="topbar-title">
				<span class="t">{session?.title || 'New session'}</span>
				<span class="s">
					{#if session}<StatusDot status={session.status} />{/if}
					{session ? shortPath(session.cwd, app.home) : ''}
				</span>
			</div>
			<button class="icon-btn" aria-label="Changes" disabled={!session} onclick={() => goto(`/changes?cwd=${encodeURIComponent(session.cwd)}&session=${encodeURIComponent(id)}`)}>
				<Icon name="git" />
			</button>
			<button class="icon-btn" aria-label="More" onclick={() => (menuOpen = true)}><Icon name="more" /></button>
		</div>
	</header>

	<div class="scroller" bind:this={scroller} {onscroll}>
		<div class="timeline">
			{#if loading && !items.length}
				<div class="empty"><span class="spinner"></span><div class="muted" style="margin-top:10px">Loading conversation…</div></div>
			{:else if loadError}
				<div class="empty"><p>Couldn’t open this session.</p><p class="muted small">{loadError}</p><button class="btn small" onclick={() => app.subscribe(id).then(() => (loadError = null)).catch((e) => (loadError = e.message))}>Retry</button></div>
			{:else if !items.length}
				<div class="welcome">
					<div class="w-title">What should Devin work on?</div>
					<div class="muted">in <span class="mono">{session ? baseName(session.cwd) : ''}</span></div>
				</div>
			{/if}

			{#each items as item, i (item.key)}
				{#if item.kind === 'user'}
					<div class="msg user">
						<div class="bubble">
							{#if item.images}<div class="imgnote"><Icon name="image" size={14} /> {item.images} image{item.images > 1 ? 's' : ''}</div>{/if}
							{item.text}
						</div>
					</div>
				{:else if item.kind === 'agent'}
					<div class="msg agent"><Markdown text={item.text} /></div>
				{:else if item.kind === 'thought'}
					<div class="msg"><Thought text={item.text} live={lastThoughtLive && i === items.length - 1} /></div>
				{:else if item.kind === 'tool'}
					<div class="msg"><ToolCall {item} cwd={session?.cwd ?? ''} /></div>
				{:else if item.kind === 'plan'}
					<div class="msg"><PlanCard entries={item.entries} /></div>
				{:else if item.kind === 'permission'}
					<div class="msg">
						<PermissionCard
							toolCall={item.toolCall}
							options={item.options}
							resolved={item.resolved || !pendingIds.has(item.requestId)}
							optionId={item.optionId}
							onselect={(o) => resolve(item.requestId, o)}
						/>
					</div>
				{:else if item.kind === 'turn_end'}
					{#if item.stopReason && item.stopReason !== 'end_turn'}
						<div class="divider">{item.stopReason === 'cancelled' ? 'Stopped' : item.stopReason.replace(/_/g, ' ')}</div>
					{/if}
				{:else if item.kind === 'error'}
					<div class="msg"><div class="error-card"><Icon name="x" size={14} /> {item.message}</div></div>
				{/if}
			{/each}

			{#if showWorking}
				<div class="working"><span class="dots"><i></i><i></i><i></i></span> Working</div>
			{/if}
		</div>
	</div>

	{#if showJump}
		<button class="jump" aria-label="Scroll to bottom" onclick={() => { stick = true; scrollToBottom(); }}><Icon name="down" size={18} /></button>
	{/if}

	<Composer {session} {running} onsend={send} onstop={stop} onconfig={() => (configOpen = true)} />
</div>

{#if session}
	<ConfigSheet bind:open={configOpen} {session} />
{/if}

<Sheet bind:open={menuOpen} title="Session">
	<div class="list">
		<button class="row" onclick={() => { menuOpen = false; goto(`/changes?cwd=${encodeURIComponent(session.cwd)}&session=${encodeURIComponent(id)}`); }}>
			<Icon name="git" size={18} /><div class="main"><div class="title">Changes & diff</div></div>
		</button>
		<button class="row" onclick={() => { menuOpen = false; goto(`/changes?cwd=${encodeURIComponent(session.cwd)}&session=${encodeURIComponent(id)}&tab=tests`); }}>
			<Icon name="flask" size={18} /><div class="main"><div class="title">Run tests</div></div>
		</button>
		<button class="row" onclick={() => { menuOpen = false; goto(`/terminal?cwd=${encodeURIComponent(session.cwd)}`); }}>
			<Icon name="terminal" size={18} /><div class="main"><div class="title">Terminal in project</div></div>
		</button>
		<button class="row" onclick={() => { menuOpen = false; goto(`/terminal?cwd=${encodeURIComponent(session.cwd)}&kind=devin&resume=${encodeURIComponent(id)}`); }}>
			<Icon name="sparkle" size={18} /><div class="main"><div class="title">Open in Devin CLI (TUI)</div><div class="sub">For features not in the mobile UI</div></div>
		</button>
		<button class="row" onclick={() => { menuOpen = false; configOpen = true; }}>
			<Icon name="settings" size={18} /><div class="main"><div class="title">Model & mode</div></div>
		</button>
		<button class="row" onclick={closeSession}>
			<Icon name="power" size={18} /><div class="main"><div class="title">End session</div><div class="sub">Stops the agent; history stays resumable</div></div>
		</button>
		<button class="row danger" onclick={deleteSession}>
			<Icon name="trash" size={18} /><div class="main"><div class="title">Delete session</div></div>
		</button>
	</div>
</Sheet>

<style>
	.chat {
		height: var(--vvh, 100dvh);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.topbar-title .s {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		justify-content: center;
	}
	.scroller {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}
	.timeline {
		max-width: 760px;
		margin: 0 auto;
		padding: 14px 16px 24px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.msg.user {
		display: flex;
		justify-content: flex-end;
		margin-top: 8px;
	}
	.bubble {
		max-width: 85%;
		background: var(--bg-elev-2);
		border-radius: 20px 20px 6px 20px;
		padding: 9px 14px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.imgnote {
		display: flex;
		gap: 6px;
		align-items: center;
		font-size: 12px;
		color: var(--text-3);
		margin-bottom: 2px;
	}
	.msg.agent {
		font-size: 15.5px;
		line-height: 1.6;
	}
	.divider {
		text-align: center;
		font-size: 12px;
		color: var(--text-3);
		text-transform: capitalize;
	}
	.error-card {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		color: #fecaca;
		background: var(--red-bg);
		border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
		border-radius: 12px;
		padding: 10px 12px;
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.welcome {
		padding: 22vh 8px 0;
		text-align: center;
	}
	.w-title {
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.01em;
		margin-bottom: 6px;
	}
	.working {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-3);
		font-size: 13.5px;
		padding: 4px 0;
	}
	.dots {
		display: inline-flex;
		gap: 3px;
	}
	.dots i {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--text-3);
		animation: pulse 1s infinite;
	}
	.dots i:nth-child(2) {
		animation-delay: 0.15s;
	}
	.dots i:nth-child(3) {
		animation-delay: 0.3s;
	}
	.jump {
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
		bottom: calc(var(--safe-bottom) + 120px);
		width: 38px;
		height: 38px;
		border-radius: 50%;
		background: var(--bg-elev-2);
		border: 1px solid var(--border);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
		z-index: 5;
	}
	.row.danger {
		color: var(--red);
	}
	.small {
		font-size: 13px;
	}
</style>
