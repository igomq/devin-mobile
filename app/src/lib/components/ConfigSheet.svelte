<script lang="ts">
	import Sheet from './Sheet.svelte';
	import Icon from './Icon.svelte';
	import { app } from '#lib/app.svelte.ts';
	import type { ConfigOption, ConfigOptionValue, SessionSummary } from '#lib/types.ts';

	let { open = $bindable(false), session }: { open: boolean; session: SessionSummary } = $props();
	let busy = $state<string | null>(null);
	let expanded = $state<string | null>(null);

	const hasModeOption = $derived(session.configOptions.some((o) => o.category === 'mode'));

	function flat(o: ConfigOption): ConfigOptionValue[] {
		return (o.options ?? []).flatMap((x) => ('options' in x ? x.options : [x]));
	}

	async function setOption(o: ConfigOption, value: string) {
		busy = o.id;
		try {
			const r = await app.req<{ session: SessionSummary }>('session.setConfig', { sessionId: session.sessionId, configId: o.id, value });
			if (r.session) app.sessions[session.sessionId] = r.session;
			expanded = null;
		} catch (e) {
			app.showError(e);
		} finally {
			busy = null;
		}
	}

	async function setMode(modeId: string) {
		busy = 'mode';
		try {
			const r = await app.req<{ session: SessionSummary }>('session.setMode', { sessionId: session.sessionId, modeId });
			if (r.session) app.sessions[session.sessionId] = r.session;
			expanded = null;
		} catch (e) {
			app.showError(e);
		} finally {
			busy = null;
		}
	}
</script>

<Sheet bind:open title="Session options">
	<div class="list">
		{#each session.configOptions.filter((o) => o.type === 'select') as o (o.id)}
			{@const values = flat(o)}
			{@const cur = values.find((v) => v.value === o.currentValue)}
			<button class="row" onclick={() => (expanded = expanded === o.id ? null : o.id)}>
				<div class="main">
					<div class="title">{o.name}</div>
					{#if o.description}<div class="sub">{o.description}</div>{/if}
				</div>
				{#if busy === o.id}<span class="spinner"></span>{:else}<span class="muted cur">{cur?.name ?? o.currentValue}</span>{/if}
				<Icon name={expanded === o.id ? 'down' : 'chevron'} size={16} />
			</button>
			{#if expanded === o.id}
				<div class="choices">
					{#each values as v (v.value)}
						<button class="choice" class:on={v.value === o.currentValue} onclick={() => setOption(o, v.value)}>
							<div class="main">
								<div>{v.name}</div>
								{#if v.description}<div class="sub">{v.description}</div>{/if}
							</div>
							{#if v.value === o.currentValue}<Icon name="check" size={16} />{/if}
						</button>
					{/each}
				</div>
			{/if}
		{/each}
		{#if session.modes && !hasModeOption}
			{@const m = session.modes}
			<button class="row" onclick={() => (expanded = expanded === '__mode' ? null : '__mode')}>
				<div class="main"><div class="title">Mode</div></div>
				{#if busy === 'mode'}<span class="spinner"></span>{:else}<span class="muted cur">{m.availableModes.find((x) => x.id === m.currentModeId)?.name}</span>{/if}
				<Icon name={expanded === '__mode' ? 'down' : 'chevron'} size={16} />
			</button>
			{#if expanded === '__mode'}
				<div class="choices">
					{#each m.availableModes as mode (mode.id)}
						<button class="choice" class:on={mode.id === m.currentModeId} onclick={() => setMode(mode.id)}>
							<div class="main">
								<div>{mode.name}</div>
								{#if mode.description}<div class="sub">{mode.description}</div>{/if}
							</div>
							{#if mode.id === m.currentModeId}<Icon name="check" size={16} />{/if}
						</button>
					{/each}
				</div>
			{/if}
		{/if}
		{#if !session.configOptions.length && !session.modes}
			<div class="empty">Options appear once the session is loaded.</div>
		{/if}
	</div>
</Sheet>

<style>
	.cur {
		font-size: 14px;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.choices {
		background: var(--bg);
		margin: 0 12px 8px;
		border-radius: 12px;
		border: 1px solid var(--border);
		max-height: 45dvh;
		overflow-y: auto;
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		text-align: left;
		padding: 11px 14px;
		font-size: 14.5px;
	}
	.choice + .choice {
		border-top: 1px solid var(--border);
	}
	.choice.on {
		font-weight: 600;
	}
	.choice .main {
		flex: 1;
		min-width: 0;
	}
	.choice .sub,
	.row .sub {
		font-size: 12.5px;
		color: var(--text-3);
		font-weight: 400;
		white-space: normal;
	}
</style>
