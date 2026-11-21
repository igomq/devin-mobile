<script lang="ts">
	import type { SessionStatus } from '#lib/types.ts';
	let { status, label = false }: { status: SessionStatus; label?: boolean } = $props();
	const text: Record<SessionStatus, string> = {
		idle: 'Idle',
		running: 'Working',
		awaiting_permission: 'Needs approval',
		error: 'Error',
		unloaded: 'Saved'
	};
</script>

<span class="status {status}" class:with-label={label}>
	<span class="dot"></span>
	{#if label}<span class="label">{text[status]}</span>{/if}
</span>

<style>
	.status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 500;
		color: var(--text-3);
		flex: none;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-3);
		opacity: 0.6;
	}
	.idle .dot {
		background: var(--text-3);
	}
	.running {
		color: var(--blue);
	}
	.running .dot {
		background: var(--blue);
		opacity: 1;
		animation: pulse 1.2s ease-in-out infinite;
	}
	.awaiting_permission {
		color: var(--amber);
	}
	.awaiting_permission .dot {
		background: var(--amber);
		opacity: 1;
		animation: pulse 1.2s ease-in-out infinite;
	}
	.error {
		color: var(--red);
	}
	.error .dot {
		background: var(--red);
		opacity: 1;
	}
	.unloaded .dot {
		background: transparent;
		border: 1.5px solid var(--text-3);
	}
</style>
