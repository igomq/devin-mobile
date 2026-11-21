<script lang="ts">
	import Icon from './Icon.svelte';
	import Markdown from './Markdown.svelte';
	let { text, live = false }: { text: string; live?: boolean } = $props();
	let open = $state(false);
	const preview = $derived(text.replace(/\s+/g, ' ').trim().slice(-140));
</script>

<div class="thought" class:open>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<Icon name="brain" size={15} />
		<span class="label" class:live>{live ? 'Thinking' : 'Thought'}</span>
		{#if !open}<span class="preview">{preview}</span>{/if}
		<span class="chev"><Icon name="down" size={14} /></span>
	</button>
	{#if open}
		<div class="body"><Markdown {text} /></div>
	{/if}
</div>

<style>
	.thought {
		color: var(--text-3);
		font-size: 13.5px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		padding: 4px 0;
		color: var(--text-3);
		min-height: 32px;
	}
	.label {
		font-weight: 500;
		color: var(--text-2);
		flex: none;
	}
	.label.live {
		background: linear-gradient(90deg, var(--text-3), var(--text), var(--text-3));
		background-size: 200% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: shimmer 1.6s linear infinite;
	}
	@keyframes shimmer {
		from {
			background-position: 200% 0;
		}
		to {
			background-position: -200% 0;
		}
	}
	.preview {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		direction: rtl;
		text-align: left;
	}
	.chev {
		display: inline-flex;
		transition: transform 0.15s;
	}
	.open .chev {
		transform: rotate(180deg);
	}
	.body {
		border-left: 2px solid var(--border);
		padding: 2px 0 2px 12px;
		margin: 4px 0 4px 7px;
		color: var(--text-2);
	}
</style>
