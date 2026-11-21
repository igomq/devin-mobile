<script lang="ts">
	import Icon from './Icon.svelte';
	import type { SessionSummary } from '#lib/types.ts';

	let {
		session,
		running,
		onsend,
		onstop,
		onconfig
	}: {
		session: SessionSummary | undefined;
		running: boolean;
		onsend: (text: string, images: { mimeType: string; data: string; name: string }[]) => Promise<void>;
		onstop: () => void;
		onconfig: () => void;
	} = $props();

	let text = $state('');
	let images = $state<{ mimeType: string; data: string; name: string; url: string }[]>([]);
	let ta: HTMLTextAreaElement;
	let fileInput: HTMLInputElement;
	let sending = $state(false);

	const slash = $derived.by(() => {
		if (!text.startsWith('/') || text.includes(' ') || !session?.commands?.length) return [];
		const q = text.slice(1).toLowerCase();
		return session.commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 6);
	});

	const chips = $derived.by(() => {
		const out: string[] = [];
		const opts = session?.configOptions ?? [];
		for (const o of opts) {
			if (o.type !== 'select') continue;
			const flat = (o.options ?? []).flatMap((x) => ('options' in x ? x.options : [x]));
			const cur = flat.find((x) => x.value === o.currentValue);
			if (cur) out.push(cur.name);
		}
		if (!opts.some((o) => o.category === 'mode') && session?.modes) {
			const m = session.modes.availableModes.find((m) => m.id === session.modes!.currentModeId);
			if (m) out.push(m.name);
		}
		return out.slice(0, 3);
	});

	function autosize() {
		if (!ta) return;
		ta.style.height = 'auto';
		ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
	}

	async function submit() {
		const t = text.trim();
		if ((!t && !images.length) || sending) return;
		sending = true;
		const imgs = images.map(({ mimeType, data, name }) => ({ mimeType, data, name }));
		const prev = text;
		text = '';
		images = [];
		queueMicrotask(autosize);
		try {
			await onsend(t, imgs);
		} catch {
			text = prev;
			queueMicrotask(autosize);
		} finally {
			sending = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(hover: hover)').matches) {
			e.preventDefault();
			submit();
		}
	}

	async function onfiles(e: Event) {
		const files = [...((e.target as HTMLInputElement).files ?? [])];
		for (const f of files.slice(0, 4)) {
			if (!f.type.startsWith('image/') || f.size > 8 * 1024 * 1024) continue;
			const buf = await f.arrayBuffer();
			let bin = '';
			const bytes = new Uint8Array(buf);
			for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			images.push({ mimeType: f.type, data: btoa(bin), name: f.name, url: URL.createObjectURL(f) });
		}
		fileInput.value = '';
	}
</script>

<div class="composer">
	{#if slash.length}
		<div class="slash">
			{#each slash as c (c.name)}
				<button
					class="slash-item"
					onclick={() => {
						text = `/${c.name} `;
						ta.focus();
					}}
				>
					<span class="mono">/{c.name}</span>
					{#if c.description}<span class="muted">{c.description}</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
	<div class="box">
		{#if images.length}
			<div class="thumbs">
				{#each images as img, i (img.url)}
					<div class="thumb">
						<img src={img.url} alt={img.name} />
						<button aria-label="Remove image" onclick={() => images.splice(i, 1)}><Icon name="x" size={12} stroke={2.5} /></button>
					</div>
				{/each}
			</div>
		{/if}
		<textarea
			bind:this={ta}
			bind:value={text}
			oninput={autosize}
			{onkeydown}
			rows="1"
			placeholder={running ? 'Send a follow-up…' : 'Ask Devin to do something…'}
			enterkeyhint="send"
			autocapitalize="sentences"
		></textarea>
		<div class="bar">
			<button class="tool" aria-label="Attach image" onclick={() => fileInput.click()}><Icon name="plus" size={18} /></button>
			<input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={onfiles} />
			<button class="chips" onclick={onconfig} aria-label="Model and mode">
				{#each chips as c, i (i)}<span class="chip">{c}</span>{/each}
				{#if !chips.length}<span class="chip"><Icon name="settings" size={13} /> Options</span>{/if}
			</button>
			<span class="spacer"></span>
			{#if running && !text.trim() && !images.length}
				<button class="send stop" aria-label="Stop" onclick={onstop}><Icon name="stop" size={14} stroke={0} /></button>
			{:else}
				<button class="send" aria-label="Send" disabled={(!text.trim() && !images.length) || sending} onclick={submit}>
					{#if sending}<span class="spinner"></span>{:else}<Icon name="send" size={18} stroke={2.2} />{/if}
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.composer {
		position: relative;
		padding: 8px 10px calc(8px + var(--safe-bottom));
		background: linear-gradient(to bottom, transparent, var(--bg) 14px);
	}
	.box {
		border: 1px solid var(--border);
		background: var(--bg-elev);
		border-radius: 22px;
		padding: 4px 6px 6px;
		max-width: 760px;
		margin: 0 auto;
	}
	.box:focus-within {
		border-color: var(--border-strong);
	}
	textarea {
		display: block;
		width: 100%;
		resize: none;
		background: transparent;
		border: 0;
		outline: none;
		padding: 10px 10px 4px;
		max-height: 180px;
		line-height: 1.4;
	}
	textarea::placeholder {
		color: var(--text-3);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.tool {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-2);
		border: 1px solid var(--border);
	}
	.chips {
		display: flex;
		gap: 4px;
		min-width: 0;
		overflow: hidden;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
		color: var(--text-2);
		padding: 5px 10px;
		border-radius: 999px;
		background: var(--bg-elev-2);
		white-space: nowrap;
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.send {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-text);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}
	.send:disabled {
		background: var(--bg-elev-2);
		color: var(--text-3);
	}
	.send.stop :global(svg) {
		fill: currentColor;
	}
	.thumbs {
		display: flex;
		gap: 8px;
		padding: 8px 6px 0;
		overflow-x: auto;
	}
	.thumb {
		position: relative;
		width: 56px;
		height: 56px;
		flex: none;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: 10px;
		border: 1px solid var(--border);
	}
	.thumb button {
		position: absolute;
		top: -6px;
		right: -6px;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: var(--text);
		color: var(--bg);
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.slash {
		position: absolute;
		left: 10px;
		right: 10px;
		bottom: 100%;
		max-width: 760px;
		margin: 0 auto;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 14px;
		overflow: hidden;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
	}
	.slash-item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		padding: 10px 14px;
		text-align: left;
		font-size: 14px;
	}
	.slash-item + .slash-item {
		border-top: 1px solid var(--border);
	}
	.slash-item .muted {
		font-size: 12px;
	}
</style>
