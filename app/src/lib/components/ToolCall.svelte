<script lang="ts">
	import Icon from './Icon.svelte';
	import DiffLines from './DiffLines.svelte';
	import Markdown from './Markdown.svelte';
	import { diffTexts } from '#lib/diff.ts';
	import type { Item } from '#lib/timeline.svelte.ts';

	let { item, cwd }: { item: Item & { kind: 'tool' }; cwd: string } = $props();
	let open = $state(false);

	const icon = $derived(
		({
			read: 'read',
			edit: 'edit',
			delete: 'trash',
			move: 'file',
			search: 'search',
			execute: 'terminal',
			think: 'brain',
			fetch: 'globe',
			switch_mode: 'refresh'
		}) as Record<string, string>
	);
	const rel = (p: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p);
	const diffs = $derived(item.content.filter((c) => c.type === 'diff'));
	const stats = $derived.by(() => {
		let add = 0;
		let del = 0;
		for (const d of diffs) {
			if (d.type !== 'diff') continue;
			for (const l of diffTexts(d.oldText, d.newText)) {
				if (l.t === '+') add++;
				else if (l.t === '-') del++;
			}
		}
		return { add, del };
	});
	const command = $derived(
		item.toolKind === 'execute' ? (item.rawInput?.command ?? item.rawInput?.cmd ?? null) : null
	);
	const rawOut = $derived.by(() => {
		const o = item.rawOutput;
		if (o == null) return '';
		if (typeof o === 'string') return o;
		if (typeof o?.output === 'string') return o.output;
		if (typeof o?.stdout === 'string') return o.stdout + (o.stderr ? `\n${o.stderr}` : '');
		return JSON.stringify(o, null, 2);
	});
	const texts = $derived(item.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n'));
</script>

<div class="tool" class:open>
	<button class="head" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="ic {item.status}">
			{#if item.status === 'in_progress' || item.status === 'pending'}
				<span class="spinner"></span>
			{:else}
				<Icon name={icon[item.toolKind] ?? 'tool'} size={15} />
			{/if}
		</span>
		<span class="title">{item.title}</span>
		{#if diffs.length}
			<span class="stat"><span class="a">+{stats.add}</span> <span class="d">-{stats.del}</span></span>
		{/if}
		{#if item.status === 'failed'}<span class="failed">failed</span>{/if}
		<span class="chev"><Icon name="down" size={14} /></span>
	</button>
	{#if open}
		<div class="body">
			{#if item.locations.length && !diffs.length}
				<div class="locs">
					{#each item.locations as l, i (i)}
						<div class="mono loc">{rel(l.path)}{l.line ? `:${l.line}` : ''}</div>
					{/each}
				</div>
			{/if}
			{#if command}
				<pre class="cmd"><span class="muted">$</span> {command}</pre>
			{/if}
			{#each diffs as d, i (i)}
				{#if d.type === 'diff'}
					<div class="file">
						<div class="fname mono">{rel(d.path)}</div>
						<DiffLines lines={diffTexts(d.oldText, d.newText)} max={400} />
					</div>
				{/if}
			{/each}
			{#if texts.trim()}
				<div class="text"><Markdown text={texts} /></div>
			{:else if rawOut.trim() && !diffs.length}
				<pre class="out">{rawOut.length > 20000 ? rawOut.slice(0, 20000) + '\n…' : rawOut}</pre>
			{/if}
			{#if item.rawInput && !command && !diffs.length && !texts.trim()}
				<pre class="out">{JSON.stringify(item.rawInput, null, 2)}</pre>
			{/if}
		</div>
	{/if}
</div>

<style>
	.tool {
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-elev);
		overflow: hidden;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 12px;
		text-align: left;
		font-size: 13.5px;
		min-height: 40px;
	}
	.ic {
		width: 18px;
		display: inline-flex;
		justify-content: center;
		color: var(--text-2);
		flex: none;
	}
	.ic.in_progress,
	.ic.pending {
		color: var(--blue);
	}
	.ic.failed {
		color: var(--red);
	}
	.ic .spinner {
		width: 12px;
		height: 12px;
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-2);
	}
	.stat {
		font-family: var(--mono);
		font-size: 12px;
		flex: none;
	}
	.a {
		color: var(--green);
	}
	.d {
		color: var(--red);
	}
	.failed {
		font-size: 12px;
		color: var(--red);
	}
	.chev {
		color: var(--text-3);
		transition: transform 0.15s;
		display: inline-flex;
	}
	.open .chev {
		transform: rotate(180deg);
	}
	.body {
		border-top: 1px solid var(--border);
		font-size: 13px;
	}
	.locs {
		padding: 8px 12px;
		color: var(--text-2);
		font-size: 12px;
	}
	.loc {
		overflow-wrap: anywhere;
	}
	.cmd,
	.out {
		margin: 0;
		padding: 10px 12px;
		font-size: 12px;
		line-height: 1.55;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 360px;
		overflow-y: auto;
	}
	.cmd {
		border-bottom: 1px solid var(--border);
		color: var(--text);
	}
	.out {
		color: var(--text-2);
	}
	.file + .file {
		border-top: 1px solid var(--border);
	}
	.fname {
		font-size: 12px;
		padding: 6px 12px;
		color: var(--text-2);
		border-bottom: 1px solid var(--border);
	}
	.text {
		padding: 10px 12px;
		max-height: 360px;
		overflow-y: auto;
	}
</style>
