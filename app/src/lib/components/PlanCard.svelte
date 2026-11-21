<script lang="ts">
	import Icon from './Icon.svelte';
	let { entries }: { entries: { content: string; status: string }[] } = $props();
	let open = $state(true);
	const done = $derived(entries.filter((e) => e.status === 'completed').length);
</script>

<div class="plan">
	<button class="head" onclick={() => (open = !open)}>
		<Icon name="list" size={15} />
		<span class="t">Plan</span>
		<span class="muted">{done}/{entries.length}</span>
		<span class="spacer"></span>
		<span class="chev" class:open><Icon name="down" size={14} /></span>
	</button>
	{#if open}
		<ul>
			{#each entries as e, i (i)}
				<li class={e.status}>
					<span class="box">
						{#if e.status === 'completed'}<Icon name="check" size={12} stroke={2.5} />{:else if e.status === 'in_progress'}<span class="spinner"></span>{/if}
					</span>
					<span>{e.content}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.plan {
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-elev);
		font-size: 13.5px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 10px 12px;
		color: var(--text-2);
	}
	.t {
		font-weight: 600;
		color: var(--text);
	}
	.chev {
		display: inline-flex;
		transition: transform 0.15s;
		color: var(--text-3);
	}
	.chev.open {
		transform: rotate(180deg);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0 12px 10px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	li {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		color: var(--text-2);
	}
	li.completed {
		color: var(--text-3);
		text-decoration: line-through;
	}
	li.in_progress {
		color: var(--text);
	}
	.box {
		width: 16px;
		height: 16px;
		border-radius: 5px;
		border: 1.5px solid var(--border-strong);
		flex: none;
		margin-top: 2px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.completed .box {
		background: var(--green);
		border-color: var(--green);
		color: #052e16;
	}
	.in_progress .box {
		border-color: var(--blue);
		color: var(--blue);
	}
	.box .spinner {
		width: 9px;
		height: 9px;
		border-width: 1.5px;
	}
</style>
