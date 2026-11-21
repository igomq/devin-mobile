<script lang="ts">
	import Icon from './Icon.svelte';
	import DiffLines from './DiffLines.svelte';
	import { diffTexts } from '#lib/diff.ts';
	import type { Json, PermissionOption } from '#lib/types.ts';

	let {
		toolCall,
		options,
		resolved = false,
		optionId = null,
		onselect
	}: {
		toolCall: Json;
		options: PermissionOption[];
		resolved?: boolean;
		optionId?: string | null;
		onselect?: (optionId: string | null) => Promise<void> | void;
	} = $props();

	let busy = $state<string | null>(null);
	let showDetail = $state(false);

	const command = $derived(toolCall?.rawInput?.command ?? null);
	const diffs = $derived((toolCall?.content ?? []).filter((c: Json) => c?.type === 'diff'));
	const chosen = $derived(options.find((o) => o.optionId === optionId));
	const sorted = $derived(
		[...options].sort((a, b) => rank(a.kind) - rank(b.kind))
	);
	function rank(k: string) {
		return ({ allow_once: 0, allow_always: 1, reject_once: 2, reject_always: 3 } as Record<string, number>)[k] ?? 4;
	}

	async function pick(id: string | null) {
		if (busy || resolved) return;
		busy = id ?? 'cancel';
		try {
			await onselect?.(id);
		} finally {
			busy = null;
		}
	}
</script>

<div class="perm" class:resolved>
	<div class="head">
		<span class="ic"><Icon name="shield" size={16} /></span>
		<div class="main">
			<div class="label">{resolved ? (chosen ? chosen.name : 'Cancelled') : 'Permission required'}</div>
			<div class="title">{toolCall?.title ?? 'Tool call'}</div>
		</div>
	</div>
	{#if command}
		<pre class="cmd"><span class="muted">$</span> {command}</pre>
	{/if}
	{#if diffs.length && !resolved}
		<button class="detail-toggle" onclick={() => (showDetail = !showDetail)}>
			{showDetail ? 'Hide changes' : `Review changes (${diffs.length} file${diffs.length > 1 ? 's' : ''})`}
		</button>
		{#if showDetail}
			{#each diffs as d, i (i)}
				<div class="fname mono">{d.path}</div>
				<DiffLines lines={diffTexts(d.oldText ?? null, d.newText ?? '')} max={300} />
			{/each}
		{/if}
	{/if}
	{#if !resolved}
		<div class="actions">
			{#each sorted as o (o.optionId)}
				<button
					class="btn small {o.kind.startsWith('allow') ? (o.kind === 'allow_once' ? 'primary' : '') : 'reject'}"
					disabled={!!busy}
					onclick={() => pick(o.optionId)}
				>
					{#if busy === o.optionId}<span class="spinner"></span>{/if}
					{o.name}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.perm {
		border: 1px solid color-mix(in srgb, var(--amber) 45%, var(--border));
		background: color-mix(in srgb, var(--amber) 6%, var(--bg-elev));
		border-radius: 14px;
		overflow: hidden;
	}
	.perm.resolved {
		border-color: var(--border);
		background: var(--bg-elev);
		opacity: 0.8;
	}
	.head {
		display: flex;
		gap: 10px;
		padding: 12px 12px 10px;
		align-items: flex-start;
	}
	.ic {
		color: var(--amber);
		margin-top: 1px;
	}
	.resolved .ic {
		color: var(--text-3);
	}
	.main {
		min-width: 0;
		flex: 1;
	}
	.label {
		font-size: 12px;
		font-weight: 600;
		color: var(--amber);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.resolved .label {
		color: var(--text-3);
		text-transform: none;
		letter-spacing: 0;
	}
	.title {
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.cmd {
		margin: 0 12px 10px;
		padding: 8px 10px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		font-size: 12px;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 180px;
		overflow-y: auto;
	}
	.detail-toggle {
		margin: 0 12px 10px;
		font-size: 13px;
		color: var(--blue);
	}
	.fname {
		font-size: 12px;
		padding: 6px 12px;
		color: var(--text-2);
		border-top: 1px solid var(--border);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 0 12px 12px;
	}
	.actions .btn {
		flex: 1 1 auto;
	}
	.btn.reject {
		color: var(--text-2);
	}
</style>
