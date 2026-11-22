<script lang="ts">
  import { app, conn, rpc, refreshSessions, openSession, errorText } from '#lib/api.svelte.ts';
  import type { SessionRow } from '#lib/types.ts';
  import { go, toast, route, requests, fresh } from '#lib/ui.svelte.ts';
  import { ago, basename, shortPath } from '#lib/format.ts';
  import Icon from './Icon.svelte';
  import { notif } from '#lib/notifications.svelte.ts';
  import Sheet from './Sheet.svelte';
  import DirPicker from './DirPicker.svelte';
  import { getStorageItem, setStorageItem } from '#lib/storage.ts';

  // embedded: rendered in the tablet sidebar next to the open session.
  let { embedded = false }: { embedded?: boolean } = $props();

  let picking = $state(false);
  let harnessId = $state(getStorageItem('harness') ?? 'devin');
  let usableHarnesses = $derived(app.harnesses.filter((h) => h.enabled && (h.installed || h.id === 'devin')));
  let harnessName = (id?: string) => app.harnesses.find((h) => h.id === id)?.name ?? id ?? '';
  $effect(() => {
    if (usableHarnesses.length && !usableHarnesses.some((h) => h.id === harnessId)) harnessId = usableHarnesses[0].id;
  });
  let creating = $state(false);
  let actionsFor = $state<SessionRow | null>(null);
  let actionsOpen = $state(false);
  let confirmDelete = $state(false);
  $effect(() => {
    if (!actionsOpen) confirmDelete = false;
  });
  let showEmpty = $state(false);
  let query = $state('');
  let searchInput = $state<HTMLInputElement>();
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (fresh(requests.newSession) && conn.status === 'online') picking = true;
  });
  $effect(() => {
    if (fresh(requests.search)) searchInput?.focus();
  });

  let visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return app.sessions.filter((s) => {
      if (q) return (s.title ?? 'new session').toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q);
      return s.hasMessages || showEmpty || s.status !== 'idle';
    });
  });
  // Sessions blocked on an approval come first, whatever project they belong to.
  let waiting = $derived(visible.filter((s) => s.status === 'awaiting_permission'));
  let groups = $derived.by(() => {
    const by = new Map<string, SessionRow[]>();
    for (const s of visible) {
      if (s.status === 'awaiting_permission') continue;
      const key = s.cwd || '';
      const list = by.get(key);
      if (list) list.push(s);
      else by.set(key, [s]);
    }
    return [...by.entries()].map(([cwd, sessions]) => ({ cwd, sessions }));
  });
  let running = $derived(app.sessions.filter((s) => s.status === 'running').length);

  async function create(cwd: string) {
    creating = true;
    try {
      setStorageItem('harness', harnessId);
      const r = await rpc('sessions.create', { cwd, harnessId });
      await openSession(r.id, r.cwd);
      query = '';
      go('#/s/' + encodeURIComponent(r.id));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      creating = false;
    }
  }

  function showActions(s: SessionRow) {
    actionsFor = s;
    actionsOpen = true;
  }
  function press(s: SessionRow) {
    pressTimer = setTimeout(() => showActions(s), 480);
  }

  async function act(method: 'session.close' | 'session.delete') {
    const s = actionsFor;
    actionsOpen = false;
    if (!s) return;
    try {
      await rpc(method, { id: s.id });
      toast(method === 'session.delete' ? 'Session deleted' : 'Session ended');
      if (route.id === s.id) go('#/', true);
      refreshSessions();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  function searchKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // Handled here, so the open chat beside the sidebar does not treat it as "stop".
      e.preventDefault();
      query = '';
      searchInput?.blur();
    } else if (e.key === 'Enter' && visible[0]) {
      go('#/s/' + encodeURIComponent((waiting[0] ?? visible[0]).id));
    }
  }
</script>

{#snippet sessionRow(s: SessionRow, showFolder: boolean)}
  <a
    class="srow"
    class:on={embedded && route.id === s.id}
    href={'#/s/' + encodeURIComponent(s.id)}
    oncontextmenu={(e) => (e.preventDefault(), showActions(s))}
    ontouchstart={() => press(s)}
    ontouchend={() => clearTimeout(pressTimer)}
    ontouchmove={() => clearTimeout(pressTimer)}
  >
    <span class="dot {s.status}"></span>
    <span class="stext">
      <span class="stitle">{#if s.harnessId && s.harnessId !== 'devin'}<span class="hbadge">{harnessName(s.harnessId)}</span>{/if}{s.title || 'New session'}</span>
      {#if showFolder}<span class="sfolder">{basename(s.cwd) || 'No folder'}</span>{/if}
    </span>
    <span class="smeta">
      {#if s.status === 'running'}Working{:else if s.status === 'awaiting_permission'}<em>Needs approval</em>{:else}{ago(s.updatedAt)}{/if}
    </span>
    <button class="smore" onclick={(e) => (e.preventDefault(), e.stopPropagation(), showActions(s))} aria-label="Session actions"><Icon name="more" size={18} /></button>
  </a>
{/snippet}

<div class="screen" class:embedded>
  <header class="topbar">
    <div class="title">
      <b>{conn.info?.host ?? 'Devin'}</b>
      <small>
        <span class="dot" class:running={conn.status === 'online'} class:error={conn.status !== 'online'}></span>
        {conn.status === 'online' ? (running ? running + ' working' : 'Connected') : 'Reconnecting…'}
      </small>
    </div>
    <div class="glass-group glass">
      <button class="iconbtn bell" onclick={() => (notif.centerOpen = !notif.centerOpen)} aria-label={notif.unreadCount ? `Notifications, ${notif.unreadCount} unread` : 'Notifications'} title="Notifications"><Icon name="bell" />{#if notif.unreadCount}<span class="badge">{notif.unreadCount > 99 ? '99+' : notif.unreadCount}</span>{/if}</button>
      <button class="iconbtn" onclick={() => go('#/terminal')} aria-label="Terminal" title="Terminal"><Icon name="terminal" /></button>
      <button class="iconbtn" onclick={() => go('#/settings')} aria-label="Settings" title="Settings (⌘,)"><Icon name="settings" /></button>
    </div>
  </header>

  <main class="scroller">
    <div class="column">
      {#if conn.info?.agent?.error}
        <button class="banner warn press" onclick={() => go('#/terminal?login')}>
          <Icon name="shield" size={16} /> Devin CLI is not running on the VM. Tap to log in from the terminal.
        </button>
      {/if}

      {#if app.sessions.length}
        <label class="search">
          <Icon name="search" size={17} />
          <input bind:this={searchInput} bind:value={query} onkeydown={searchKey} type="search" placeholder="Search sessions" aria-label="Search sessions" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" />
          {#if query}<button class="clear" onclick={() => (query = '')} aria-label="Clear search"><Icon name="x" size={14} /></button>{/if}
        </label>
      {/if}

      {#if !app.sessionsLoaded}
        <div class="empty"><span class="spinner" style="margin:auto"></span></div>
      {:else if !waiting.length && !groups.length}
        <div class="empty">
          {#if query}
            <h2>No matching sessions</h2>
            <p>Nothing has “{query.trim()}” in its title or folder.</p>
          {:else}
            <h2>No sessions yet</h2>
            <p>Pick a project folder on the VM and tell Devin what to do.</p>
          {/if}
        </div>
      {:else}
        {#if waiting.length}
          <section>
            <div class="ghead"><span class="gname attention"><Icon name="shield" size={15} /> <b>Waiting for you</b></span></div>
            <div class="card">
              {#each waiting as s (s.id)}{@render sessionRow(s, true)}{/each}
            </div>
          </section>
        {/if}
        {#each groups as g (g.cwd)}
          <section>
            <div class="ghead">
              <span class="gname"><Icon name="folder" size={15} /> <b>{basename(g.cwd) || 'No folder'}</b></span>
              <span class="gpath" title={shortPath(g.cwd, conn.info?.home)}></span>
              <button class="gadd press" onclick={() => create(g.cwd)} disabled={creating || !g.cwd || conn.status !== 'online'} aria-label="New session in {basename(g.cwd)}"><Icon name="plus" size={18} /></button>
            </div>
            <div class="card">
              {#each g.sessions as s (s.id)}{@render sessionRow(s, false)}{/each}
            </div>
          </section>
        {/each}
      {/if}
      {#if app.sessionsLoaded && !query && app.sessions.some((s) => !s.hasMessages && s.status === 'idle')}
        <button class="toggle" onclick={() => (showEmpty = !showEmpty)}>{showEmpty ? 'Hide' : 'Show'} empty sessions</button>
      {/if}
    </div>
  </main>

  <div class="dock">
    {#if usableHarnesses.length > 1}
      <select class="hsel glass" bind:value={harnessId} aria-label="Harness" title="Harness for new sessions">
        {#each usableHarnesses as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
      </select>
    {/if}
    <button class="btn primary newbtn" onclick={() => (picking = true)} disabled={creating || conn.status !== 'online'} title="New session (⌘N)">
      {#if creating}<span class="spinner"></span>{:else}<Icon name="compose" size={18} />{/if} New session
    </button>
  </div>
</div>

<DirPicker bind:open={picking} onpick={create} />

<Sheet bind:open={actionsOpen} title={actionsFor?.title || 'Session'}>
  <p class="muted mono idline">{actionsFor?.id} · {shortPath(actionsFor?.cwd, conn.info?.home)}</p>
  <div class="actions">
    <button class="btn block" onclick={() => ((actionsOpen = false), go('#/s/' + encodeURIComponent(actionsFor?.id ?? '')))}>Resume</button>
    <button class="btn block" onclick={() => act('session.close')}>End session</button>
    {#if confirmDelete}
      <button class="btn block danger" onclick={() => act('session.delete')}>Delete permanently</button>
      <button class="btn block" onclick={() => (confirmDelete = false)}>Keep session</button>
    {:else}
      <button class="btn block danger" onclick={() => (confirmDelete = true)}>Delete session</button>
    {/if}
  </div>
</Sheet>

<style>
  .bell {
    position: relative;
  }
  .badge {
    position: absolute;
    top: 2px;
    right: 2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--red);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    pointer-events: none;
  }
  main {
    display: flex;
    flex-direction: column;
    padding-bottom: calc(var(--safe-bottom) + 96px);
  }
  .column {
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
    padding: 4px calc(var(--safe-right) + 16px) 0 calc(var(--safe-left) + 16px);
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  .embedded .column {
    padding: 2px 10px 0;
  }
  .banner {
    width: 100%;
    text-align: left;
    margin-bottom: 12px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 42px;
    padding: 0 8px 0 13px;
    border-radius: 999px;
    background: var(--fill);
    color: var(--text-3);
    transition: box-shadow 0.2s ease, background-color 0.2s ease;
  }
  .search:focus-within {
    background: var(--bg-elev);
    box-shadow: 0 0 0 1px var(--line), 0 0 0 4px var(--accent-soft);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: none;
    font-size: 16px;
    color: var(--text);
    -webkit-appearance: none;
    appearance: none;
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .search input::placeholder {
    color: var(--text-3);
  }
  .clear {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--text-2);
  }
  section {
    padding-top: 18px;
  }
  .ghead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 6px 6px;
    min-height: 36px;
  }
  .gname {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    color: var(--text-2);
    flex: none;
    max-width: 60%;
    overflow: hidden;
    white-space: nowrap;
  }
  .gname b {
    font-weight: 650;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gname.attention {
    color: var(--amber);
  }
  .gpath {
    flex: 1;
    min-width: 0;
    font-size: 11.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gadd {
    flex: none;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    color: var(--text-2);
    border-radius: 50%;
  }
  .gadd:active:not(:disabled) {
    background: var(--fill);
  }
  .card {
    overflow: hidden;
  }
  .srow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 54px;
    padding: 6px 4px 6px 16px;
    color: var(--text);
    text-decoration: none;
    -webkit-touch-callout: none;
    user-select: none;
    transition: background-color 0.18s ease;
  }
  /* Inset hairline between rows, starting after the status dot like iOS lists. */
  .srow + .srow::before {
    content: '';
    position: absolute;
    top: 0;
    left: 36px;
    right: 0;
    border-top: 1px solid var(--line);
  }
  .srow:active {
    background: var(--fill);
  }
  .srow.on {
    background: var(--accent-soft);
  }
  .srow.on + .srow::before,
  .srow.on::before {
    border-color: transparent;
  }
  .stext {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .stitle {
    font-size: 15.5px;
    font-weight: 500;
    line-height: 1.35;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .srow.on .stitle {
    font-weight: 600;
  }
  .sfolder {
    font-size: 12.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smeta {
    font-size: 12.5px;
    color: var(--text-3);
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .smeta em {
    font-style: normal;
    font-weight: 500;
    color: var(--amber);
  }
  .smore {
    flex: none;
    width: 36px;
    height: 44px;
    display: grid;
    place-items: center;
    color: var(--text-3);
    border-radius: 12px;
  }
  .toggle {
    margin: 16px auto 0;
    min-height: 40px;
    font-size: 13.5px;
    color: var(--text-3);
    padding: 0 14px;
    border-radius: 999px;
  }
  .toggle:active {
    background: var(--fill);
  }
  .dock {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 15;
    display: flex;
    justify-content: center;
    padding: 24px 16px calc(var(--safe-bottom) + 14px);
    pointer-events: none;
    background: linear-gradient(to top, var(--bg) 18%, color-mix(in srgb, var(--bg) 0%, transparent));
  }
  .embedded .dock {
    background: linear-gradient(to top, color-mix(in srgb, var(--bg-elev) 85%, transparent) 30%, transparent);
    padding: 20px 12px 12px;
  }
  .newbtn {
    pointer-events: auto;
    min-width: 200px;
    min-height: 50px;
    font-size: 16px;
  }
  .hsel {
    pointer-events: auto;
    min-height: 50px;
    margin-right: 8px;
    padding: 0 12px;
    border-radius: 999px;
    border: 0;
    color: var(--text);
    font: inherit;
  }
  .hbadge {
    font-size: 11px;
    padding: 1px 6px;
    margin-right: 6px;
    border-radius: 6px;
    background: var(--fill);
    color: var(--text-2, inherit);
  }
  .embedded .newbtn {
    width: 100%;
  }
  .actions {
    display: grid;
    gap: 10px;
  }
  .actions .btn {
    background: var(--fill);
  }
  .idline {
    font-size: 12px;
    margin: 0 4px 16px;
    overflow-wrap: anywhere;
  }
</style>
