<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { conn, rpc, onTerminal, views, app, errorText, refreshSessions } from '#lib/api.svelte.ts';
  import { basename } from '#lib/format.ts';
  import BackButton from './BackButton.svelte';

  let { sessionId = null, login = false }: { sessionId?: string | null; login?: boolean } = $props();
  let cwd = $derived(sessionId ? (views[sessionId]?.cwd ?? app.sessions.find((s) => s.id === sessionId)?.cwd) : null);
  // svelte-ignore state_referenced_locally
  const storeKey = 'uniharn.term.' + (login ? 'login' : (sessionId ?? 'home'));

  let host = $state<HTMLElement>();
  let termId = $state<string | null>(null);
  let exited = $state<number | null>(null);
  let ctrl = $state(false);
  let error = $state<string | null>(null);
  let term: Terminal;
  let fit: FitAddon;
  let off: (() => void) | null = null;
  let attachedGen = -1;

  const keys = [
    { label: 'esc', seq: '\x1b' },
    { label: 'tab', seq: '\t' },
    { label: '↑', seq: '\x1b[A' },
    { label: '↓', seq: '\x1b[B' },
    { label: '←', seq: '\x1b[D' },
    { label: '→', seq: '\x1b[C' },
    { label: '^C', seq: '\x03' },
    { label: '^D', seq: '\x04' },
    { label: '/', seq: '/' },
    { label: '|', seq: '|' },
    { label: '~', seq: '~' },
    { label: '-', seq: '-' }
  ];

  function sendInput(data: string) {
    if (!termId || exited !== null) return;
    if (ctrl && data.length === 1) {
      const c = data.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64);
      ctrl = false;
    }
    rpc('term.input', { id: termId, data }).catch(() => {});
  }

  function listen(id: string) {
    off?.();
    off = onTerminal(id, (msg) => {
      if (msg.ev === 'term') term.write(msg.data);
      else {
        exited = msg.code ?? 0;
        term.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
      }
    });
  }

  /** @param {string[]} [devin] arguments for an interactive `devin`; a login shell when omitted */
  async function start(devin?: string[]) {
    error = null;
    exited = null;
    term.reset();
    fit.fit();
    try {
      // After a gateway restart only the session list knows this session's project.
      if (sessionId && !cwd) await refreshSessions();
      const t = await rpc('term.open', { cwd: cwd ?? '~', devin, cols: term.cols, rows: term.rows });
      termId = t.id;
      sessionStorage.setItem(storeKey, t.id);
      listen(t.id);
    } catch (e) {
      error = errorText(e);
    }
  }

  // Re-attach to the PTY that is still running on the VM, replaying its scrollback.
  async function attachOrStart() {
    const saved = termId ?? sessionStorage.getItem(storeKey);
    if (saved) {
      try {
        const t = await rpc('term.attach', { id: saved });
        // A login that finished on an earlier visit is stale; one that finished while this screen was offline is shown.
        if (login && !termId && t.exited !== null) throw new Error('finished');
        termId = t.id;
        exited = t.exited;
        term.reset();
        term.write(t.buffer);
        listen(t.id);
        resize();
        return;
      } catch {
        sessionStorage.removeItem(storeKey);
        termId = null;
      }
    }
    await start(login ? ['auth', 'login'] : undefined);
  }

  function resize() {
    if (!fit || !host?.clientHeight) return;
    fit.fit();
    if (termId && exited === null) rpc('term.resize', { id: termId, cols: term.cols, rows: term.rows }).catch(() => {});
  }

  // Set while asking whether to close a shell that is still running.
  let replacing = $state<{ devin?: string[] } | null>(null);

  function askRestart(devin?: string[]) {
    if (!ready) return;
    if (termId && exited === null) replacing = { devin };
    else restart(devin);
  }

  async function restart(devin?: string[]) {
    replacing = null;
    // Stop listening first: the old shell's exit would otherwise mark the new one as exited.
    off?.();
    off = null;
    if (termId) await rpc('term.close', { id: termId }).catch(() => {});
    sessionStorage.removeItem(storeKey);
    termId = null;
    await start(devin);
    term.focus();
  }

  let ready = $state(false);

  onMount(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    let ro: ResizeObserver | null = null;
    let gone = false;
    // xterm measures its cell size once, so the bundled font has to be loaded before it opens.
    const fonts = Promise.all(['', 'bold '].map((w) => document.fonts.load(`${w}13px 'JetBrains Mono'`))).catch(() => {});
    fonts.then(() => {
      if (gone) return;
      term = new Terminal({
        fontFamily: v('--mono'),
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: false,
        theme: { background: v('--bg'), foreground: v('--text'), cursor: v('--text'), selectionBackground: v('--line-strong') }
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host!);
      term.onData(sendInput);
      ro = new ResizeObserver(() => resize());
      ro.observe(host!);
      ready = true;
    });
    return () => {
      gone = true;
      ro?.disconnect();
      off?.();
      // Stop the gateway streaming this PTY to us; it keeps running on the VM for re-attach.
      if (termId) rpc('term.detach', { id: termId }).catch(() => {});
      term?.dispose();
    };
  });

  $effect(() => {
    if (conn.status === 'online' && ready && attachedGen !== conn.generation) {
      attachedGen = conn.generation;
      untrack(attachOrStart);
    }
  });
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to={sessionId ? '#/s/' + encodeURIComponent(sessionId) : '#/'} label="Back" />
    <div class="title">
      <b>Terminal</b>
      <small><span class="dot" class:running={conn.status === 'online' && exited === null} class:error={conn.status !== 'online'}></span>{conn.status !== 'online' ? 'Reconnecting…' : exited !== null ? `Exited (${exited})` : (basename(cwd) || conn.info?.host || '')}</small>
    </div>
    <div class="shells glass">
      <button class="chip" onclick={() => askRestart([])}>devin</button>
      <button class="chip" onclick={() => askRestart()}>New shell</button>
    </div>
  </header>
  <div class="body">
    {#if error}<div class="banner warn">{error}</div>{/if}
    {#if replacing}
      <div class="banner warn replace">
        <span>This closes the current shell and stops anything running in it.</span>
        <button class="btn danger" onclick={() => restart(replacing?.devin)}>Close it</button>
        <button class="btn" onclick={() => (replacing = null)}>Keep</button>
      </div>
    {/if}
    <div class="term" bind:this={host}></div>
  </div>
  <div class="keys glass">
    <button class:on={ctrl} onclick={() => (ctrl = !ctrl)}>ctrl</button>
    {#each keys as k}
      <button onclick={() => (sendInput(k.seq), term?.focus())}>{k.label}</button>
    {/each}
  </div>
</div>

<style>
  /* xterm keeps its own scrollback, so it starts below the floating bar and stops above the key dock. */
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: var(--bar-h) var(--safe-right) calc(var(--safe-bottom) + 72px) var(--safe-left);
  }
  .body .banner {
    flex: none;
    margin: 0 12px;
  }
  .term {
    flex: 1;
    min-height: 0;
    padding: 4px 4px 0 10px;
    background: var(--bg);
    overflow: hidden;
  }
  .term :global(.xterm) {
    height: 100%;
  }
  .term :global(.xterm-viewport) {
    background: transparent !important;
  }
  .shells {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    height: 44px;
    padding: 0 4px;
    border-radius: 22px;
  }
  .shells .chip {
    height: 36px;
    padding: 0 12px;
    background: transparent;
    color: var(--text);
    font-weight: 600;
  }
  .shells .chip:active {
    background: var(--accent-soft);
  }
  .keys {
    position: absolute;
    z-index: 20;
    left: calc(var(--safe-left) + 12px);
    right: calc(var(--safe-right) + 12px);
    bottom: calc(var(--safe-bottom) + 10px);
    width: fit-content;
    max-width: calc(100% - var(--safe-left) - var(--safe-right) - 24px);
    margin-inline: auto;
    display: flex;
    gap: 6px;
    padding: 6px;
    border-radius: 999px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .keys::-webkit-scrollbar {
    display: none;
  }
  .keys button {
    flex: none;
    min-width: 44px;
    height: 40px;
    padding: 0 12px;
    border-radius: 999px;
    background: var(--fill);
    font: 500 13px var(--mono);
    transition: transform 0.16s var(--ease-out), background-color 0.2s ease, color 0.2s ease;
  }
  .keys button:active {
    transform: scale(0.94);
    background: var(--fill-2);
    transition-duration: 0.08s;
  }
  .keys button.on {
    background: var(--accent);
    color: var(--on-accent);
  }
  .replace {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .replace span {
    flex: 1;
  }
  .replace .btn {
    flex: none;
    min-height: 36px;
    padding: 0 14px;
    font-size: 13.5px;
    background: var(--fill);
    color: var(--text);
  }
  .replace .btn.danger {
    color: var(--red);
  }
</style>
