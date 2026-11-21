<script lang="ts">
	import type { Snippet } from 'svelte';
	let { open = $bindable(false), title, children }: { open: boolean; title?: string; children: Snippet } = $props();
</script>

{#if open}
	<div class="backdrop" role="presentation" onclick={() => (open = false)}></div>
	<div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
		<div class="grabber"></div>
		{#if title}<div class="sheet-title">{title}</div>{/if}
		<div class="sheet-body">{@render children()}</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		z-index: 90;
		animation: fade 0.15s ease-out;
	}
	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 91;
		background: var(--bg-elev);
		border-top-left-radius: 20px;
		border-top-right-radius: 20px;
		border: 1px solid var(--border);
		border-bottom: 0;
		max-height: 85dvh;
		display: flex;
		flex-direction: column;
		padding-bottom: var(--safe-bottom);
		animation: up 0.2s cubic-bezier(0.2, 0.9, 0.3, 1);
		max-width: 720px;
		margin: 0 auto;
	}
	.grabber {
		width: 36px;
		height: 5px;
		border-radius: 3px;
		background: var(--border-strong);
		margin: 8px auto 4px;
		flex: none;
	}
	.sheet-title {
		font-weight: 600;
		text-align: center;
		padding: 6px 16px 10px;
		flex: none;
	}
	.sheet-body {
		overflow-y: auto;
		padding-bottom: 12px;
	}
	@keyframes up {
		from {
			transform: translateY(100%);
		}
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
</style>
