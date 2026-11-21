<script lang="ts">
  import { app, conn, rpc, refreshSessions, openSession, errorText } from '#lib/api.svelte.ts';
  import type { SessionRow } from '#lib/types.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import { ago, basename, shortPath } from '#lib/format.ts';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import DirPicker from './DirPicker.svelte';

  let picking = $state(false);
  let creating = $state(false);
  let actionsFor = $state<SessionRow | null>(null);
  let actionsOpen = $state(false);
  let confirmDelete = $state(false);
  $effect(() => {
    if (!actionsOpen) confirmDelete = false;
  });
  let showEmpty = $state(false);
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  let groups = $derived.by(() => {
    const by = new Map<string, SessionRow[]>();
    for (const s of app.sessions) {
      if (!s.hasMessages && !showEmpty && s.status === 'idle') continue;
      const key = s.cwd || '';
      const list = by.get(key);
      if (list) list.push(s);
      else by.set(key, [s]);
    }
    return [...by.entries()].map(([cwd, sessions]) => ({ cwd, sessions }));
  });
  let active = $derived(app.sessions.filter((s) => s.status !== 'idle').length);

  async function create(cwd: string) {
    creating = true;
    try {
      const r = await rpc('sessions.create', { cwd });
      await openSession(r.id, r.cwd);
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
      refreshSessions();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
</script>

<div class="screen">
  <header class="topbar">
    <div class="title">
      <b>{conn.info?.host ?? 'Devin'}</b>
      <small>
        <span class="dot" class:running={conn.status === 'online'} class:error={conn.status !== 'online'}></span>
        {conn.status === 'online' ? (active ? `${active} running` : 'Connected') : 'Reconnecting…'}
      </small>
    </div>
    <button class="iconbtn" onclick={() => go('#/terminal')} aria-label="Terminal"><Icon name="terminal" /></button>
    <button class="iconbtn" onclick={() => go('#/settings')} aria-label="Settings"><Icon name="settings" /></button>
  </header>

  {#if conn.info?.agent?.error}
    <button class="banner warn" onclick={() => go('#/terminal?login')}>
      <Icon name="shield" size={16} /> Devin CLI is not running on the VM. Tap to log in from the terminal.
    </button>
  {/if}

  <main>
    {#if !app.sessionsLoaded}
      <div class="empty"><span class="spinner" style="margin:auto"></span></div>
    {:else if groups.length === 0}
      <div class="empty">
        <h2>No sessions yet</h2>
        <p>Pick a project folder on the VM and tell Devin what to do.</p>
      </div>
    {:else}
      {#each groups as g (g.cwd)}
        <section>
          <div class="ghead">
            <span class="gname"><Icon name="folder" size={15} /> <b>{basename(g.cwd) || 'No folder'}</b></span>
            <span class="gpath mono">{shortPath(g.cwd, conn.info?.home)}</span>
            <button class="gadd" onclick={() => create(g.cwd)} disabled={creating || !g.cwd} aria-label="New session in {basename(g.cwd)}"><Icon name="plus" size={18} /></button>
          </div>
          {#each g.sessions as s (s.id)}
            <a
              class="srow"
              href={'#/s/' + encodeURIComponent(s.id)}
              oncontextmenu={(e) => (e.preventDefault(), showActions(s))}
              ontouchstart={() => press(s)}
              ontouchend={() => clearTimeout(pressTimer)}
              ontouchmove={() => clearTimeout(pressTimer)}
            >
              <span class="dot {s.status}"></span>
              <span class="stitle">{s.title || 'New session'}</span>
              <span class="smeta">
                {#if s.status === 'running'}Working{:else if s.status === 'awaiting_permission'}<em>Needs approval</em>{:else}{ago(s.updatedAt)}{/if}
              </span>
              <button class="smore" onclick={(e) => (e.preventDefault(), e.stopPropagation(), showActions(s))} aria-label="Session actions"><Icon name="more" size={18} /></button>
            </a>
          {/each}
        </section>
      {/each}
    {/if}
    {#if app.sessionsLoaded && app.sessions.some((s) => !s.hasMessages)}
      <button class="toggle" onclick={() => (showEmpty = !showEmpty)}>{showEmpty ? 'Hide' : 'Show'} empty sessions</button>
    {/if}
  </main>

  <footer>
    <button class="btn primary block" onclick={() => (picking = true)} disabled={creating || conn.status !== 'online'}>
      {#if creating}<span class="spinner"></span>{:else}<Icon name="plus" size={18} />{/if} New session
    </button>
  </footer>
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
  main {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    display: flex;
    flex-direction: column;
    padding-bottom: 8px;
  }
  .banner {
    width: 100%;
    text-align: left;
  }
  section {
    padding: 14px 0 2px;
  }
  .ghead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px 4px 16px;
    min-height: 36px;
  }
  .gname {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    color: var(--text);
    flex: none;
    max-width: 55%;
    overflow: hidden;
    white-space: nowrap;
  }
  .gname b {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
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
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    color: var(--text-2);
    border-radius: 10px;
  }
  .srow {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 0 6px 0 18px;
    color: var(--text);
    text-decoration: none;
    -webkit-touch-callout: none;
    user-select: none;
  }
  .srow:active {
    background: var(--bg-elev);
  }
  .stitle {
    flex: 1;
    min-width: 0;
    font-size: 15.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smeta {
    font-size: 12.5px;
    color: var(--text-3);
    flex: none;
  }
  .smeta em {
    font-style: normal;
    color: var(--amber);
  }
  .smore {
    width: 36px;
    height: 44px;
    display: grid;
    place-items: center;
    color: var(--text-3);
  }
  .toggle {
    margin: 12px auto;
    font-size: 13px;
    color: var(--text-3);
    padding: 8px 12px;
  }
  footer {
    flex: none;
    padding: 10px 16px calc(var(--safe-bottom) + 12px);
    border-top: 1px solid var(--line);
  }
  .actions {
    display: grid;
    gap: 10px;
  }
  .idline {
    font-size: 12px;
    margin: 0 0 14px;
    overflow-wrap: anywhere;
  }
</style>
