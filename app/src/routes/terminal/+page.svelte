<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';
	import Icon from '#lib/components/Icon.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import { app, baseName, shortPath } from '#lib/app.svelte.ts';
	import type { TerminalInfo } from '#lib/types.ts';

	let el: HTMLElement;
	let term: Terminal | null = null;
	let fit: FitAddon | null = null;
	let termId = $state<string | null>(null);
	let info = $state<TerminalInfo | null>(null);
	let listOpen = $state(false);
	let ctrl = $state(false);
	let starting = $state(false);
	const offs: (() => void)[] = [];

	const cwdParam = $derived(page.url.searchParams.get('cwd'));

	onMount(() => {
		term = new Terminal({
			fontFamily: "ui-monospace, 'SF Mono', Menlo, 'JetBrains Mono', monospace",
			fontSize: 13,
			cursorBlink: true,
			convertEol: false,
			scrollback: 5000,
			theme: { background: '#0b0b0c', foreground: '#e4e4e7', cursor: '#f4f4f5', selectionBackground: '#3f3f46' }
		});
		fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		fit.fit();
		term.onData((d) => {
			if (!termId) return;
			if (ctrl && d.length === 1) {
				const c = d.toUpperCase().charCodeAt(0);
				if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
				ctrl = false;
			}
			app.client?.send('term.input', { termId, data: d });
		});
		term.onResize(({ cols, rows }) => termId && app.client?.send('term.resize', { termId, cols, rows }));
		const ro = new ResizeObserver(() => fit?.fit());
		ro.observe(el);
		offs.push(() => ro.disconnect());
	});

	$effect(() => {
		const c = app.client;
		if (!c) return;
		const a = c.on('term_data', (m) => {
			if (m.termId === termId) term?.write(m.data);
		});
		const b = c.on('term_exit', (m) => {
			if (m.term.termId === termId) {
				info = m.term;
				term?.write(`\r\n\x1b[2m[process exited with code ${m.term.exitCode}]\x1b[0m\r\n`);
			}
		});
		return () => {
			a();
			b();
		};
	});

	// (re)attach on connect / reconnect
	let attachedConn = false;
	$effect(() => {
		const open = app.conn === 'open';
		if (!open) {
			attachedConn = false;
			return;
		}
		if (attachedConn || !term) return;
		attachedConn = true;
		if (termId) attach(termId);
		else initial();
	});

	async function initial() {
		const p = page.url.searchParams;
		const want = p.get('term');
		if (want) return attach(want);
		if (p.get('kind') === 'devin' || p.get('cwd')) return openNew((p.get('kind') as 'devin') ?? 'shell', p.get('cwd') ?? undefined, p.get('resume') ?? undefined);
		const live = app.terminals.find((t) => !t.exited);
		if (live) return attach(live.termId);
		return openNew('shell');
	}

	async function attach(id: string) {
		try {
			const r = await app.req<{ term: TerminalInfo; scrollback: string }>('term.attach', { termId: id });
			if (termId && termId !== id) app.client?.send('term.detach', { termId });
			termId = id;
			info = r.term;
			term?.reset();
			term?.write(r.scrollback);
			fit?.fit();
			if (term) app.client?.send('term.resize', { termId: id, cols: term.cols, rows: term.rows });
			history.replaceState(history.state, '', `/terminal?term=${encodeURIComponent(id)}`);
		} catch (e) {
			app.showError(e);
			if (!termId) openNew('shell');
		}
	}

	async function openNew(kind: 'shell' | 'devin', cwd?: string, resume?: string) {
		if (starting) return;
		starting = true;
		try {
			const r = await app.req<{ term: TerminalInfo }>('term.open', {
				cwd: cwd ?? cwdParam ?? app.home ?? '~',
				kind,
				args: kind === 'devin' && resume ? ['--resume', resume] : [],
				cols: term?.cols ?? 80,
				rows: term?.rows ?? 24
			});
			app.terminals = [...app.terminals.filter((t) => t.termId !== r.term.termId), r.term];
			if (termId) app.client?.send('term.detach', { termId });
			termId = r.term.termId;
			info = r.term;
			term?.reset();
			listOpen = false;
			history.replaceState(history.state, '', `/terminal?term=${encodeURIComponent(r.term.termId)}`);
			term?.focus();
		} catch (e) {
			app.showError(e);
		} finally {
			starting = false;
		}
	}

	async function closeTerm(id: string) {
		await app.req('term.close', { termId: id }).catch((e) => app.showError(e));
		app.terminals = app.terminals.filter((t) => t.termId !== id);
		if (id === termId) {
			termId = null;
			const next = app.terminals.find((t) => !t.exited);
			if (next) attach(next.termId);
			else openNew('shell');
		}
	}

	async function showList() {
		listOpen = true;
		try {
			const r = await app.req<{ terminals: TerminalInfo[] }>('term.list');
			app.terminals = r.terminals;
		} catch {
			/* ignore */
		}
	}

	function key(data: string) {
		if (termId) app.client?.send('term.input', { termId, data });
		term?.focus();
	}

	onDestroy(() => {
		offs.forEach((f) => f());
		if (termId) app.client?.send('term.detach', { termId });
		term?.dispose();
	});

	const keys: [string, string][] = [
		['esc', '\x1b'],
		['tab', '\t'],
		['↑', '\x1b[A'],
		['↓', '\x1b[B'],
		['←', '\x1b[D'],
		['→', '\x1b[C'],
		['^C', '\x03'],
		['^D', '\x04'],
		['/', '/'],
		['|', '|'],
		['~', '~'],
		['-', '-']
	];
</script>

<div class="termscreen">
	<header class="topbar bordered">
		<div class="topbar-row">
			<button class="icon-btn" aria-label="Back" onclick={() => (history.length > 1 ? history.back() : goto('/'))}><Icon name="back" /></button>
			<button class="topbar-title" onclick={showList}>
				<span class="t">{info?.title ?? 'Terminal'} <Icon name="down" size={12} /></span>
				<span class="s mono">{info ? shortPath(info.cwd, app.home) : ''}</span>
			</button>
			<button class="icon-btn" aria-label="New terminal" onclick={() => openNew('shell', info?.cwd)}><Icon name="plus" /></button>
		</div>
	</header>
	<div class="term" bind:this={el}></div>
	<div class="keys">
		<button class="k" class:on={ctrl} onclick={() => { ctrl = !ctrl; term?.focus(); }}>ctrl</button>
		{#each keys as [label, data] (label)}
			<button class="k" onclick={() => key(data)}>{label}</button>
		{/each}
	</div>
</div>

<Sheet bind:open={listOpen} title="Terminals">
	<div class="list">
		{#each app.terminals as t (t.termId)}
			<div class="row" class:cur={t.termId === termId}>
				<button class="main sel" onclick={() => { listOpen = false; attach(t.termId); }}>
					<div class="title">{t.title} <span class="muted">· {baseName(t.cwd)}</span></div>
					<div class="sub mono">{t.exited ? `exited ${t.exitCode}` : t.command}</div>
				</button>
				<button class="icon-btn" aria-label="Close terminal" onclick={() => closeTerm(t.termId)}><Icon name="x" size={16} /></button>
			</div>
		{/each}
		<button class="row" onclick={() => openNew('shell', info?.cwd)}>
			<Icon name="terminal" size={18} /><div class="main"><div class="title">New shell</div></div>
		</button>
		<button class="row" onclick={() => openNew('devin', info?.cwd)}>
			<Icon name="sparkle" size={18} /><div class="main"><div class="title">New Devin CLI (TUI)</div><div class="sub">Full CLI for features not in the app</div></div>
		</button>
	</div>
</Sheet>

<style>
	.termscreen {
		height: var(--vvh, 100dvh);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: #0b0b0c;
	}
	.topbar-title {
		cursor: pointer;
	}
	.topbar-title .t {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.term {
		flex: 1;
		min-height: 0;
		padding: 6px 4px 0 8px;
	}
	.keys {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		padding: 8px 8px calc(8px + var(--safe-bottom));
		border-top: 1px solid var(--border);
		background: var(--bg-elev);
		scrollbar-width: none;
		flex: none;
	}
	.k {
		flex: none;
		min-width: 42px;
		height: 36px;
		padding: 0 10px;
		border-radius: 9px;
		background: var(--bg-elev-2);
		border: 1px solid var(--border);
		font-family: var(--mono);
		font-size: 13px;
	}
	.k.on {
		background: var(--accent);
		color: var(--accent-text);
	}
	.row.cur {
		background: var(--bg-elev-2);
	}
	.sel {
		text-align: left;
	}
</style>
