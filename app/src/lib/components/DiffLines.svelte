<script lang="ts">
	import type { DiffLine } from '#lib/diff.ts';
	let { lines, max = 4000 }: { lines: DiffLine[]; max?: number } = $props();
	let showAll = $state(false);
	const shown = $derived(showAll ? lines : lines.slice(0, max));
</script>

<div class="diff">
	<div class="inner">
		{#each shown as l, i (i)}
			<div class="ln {l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '@' ? 'hunk' : ''}">
				<span class="no">{l.t === '@' ? '' : (l.t === '-' ? l.a : l.b) ?? ''}</span>
				<span class="sign">{l.t === '@' ? '' : l.t}</span>
				<span class="code">{l.text || ' '}</span>
			</div>
		{/each}
	</div>
	{#if lines.length > shown.length}
		<button class="more" onclick={() => (showAll = true)}>Show {lines.length - shown.length} more lines</button>
	{/if}
</div>

<style>
	.diff {
		font-family: var(--mono);
		font-size: 12px;
		line-height: 1.6;
		overflow-x: auto;
		background: var(--bg);
	}
	.inner {
		min-width: max-content;
	}
	.ln {
		display: flex;
		white-space: pre;
	}
	.no {
		width: 42px;
		flex: none;
		text-align: right;
		padding-right: 8px;
		color: var(--text-3);
		user-select: none;
		opacity: 0.7;
	}
	.sign {
		width: 14px;
		flex: none;
		color: var(--text-3);
		user-select: none;
	}
	.code {
		padding-right: 16px;
	}
	.add {
		background: rgba(52, 211, 153, 0.12);
	}
	.add .sign,
	.add .code {
		color: #86efac;
	}
	.del {
		background: rgba(248, 113, 113, 0.12);
	}
	.del .sign,
	.del .code {
		color: #fca5a5;
	}
	.hunk {
		color: var(--blue);
		background: var(--blue-bg);
	}
	.hunk .code {
		padding-left: 8px;
	}
	.more {
		width: 100%;
		padding: 10px;
		color: var(--text-2);
		font-family: var(--sans);
		font-size: 13px;
		border-top: 1px solid var(--border);
	}
</style>
