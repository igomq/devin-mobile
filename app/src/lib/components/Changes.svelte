<script lang="ts">
  import { untrack } from 'svelte';
  import { views, conn, rpc, app, openSession, errorText } from '#lib/api.svelte.ts';
  import type { GitStatusView, SessionPrLink, ToolItem } from '#lib/types.ts';
  import { go } from '#lib/ui.svelte.ts';
  import { basename, shortPath } from '#lib/format.ts';
  import Icon from './Icon.svelte';
  import BackButton from './BackButton.svelte';
  import FilesPanel from './git/FilesPanel.svelte';
  import HistoryPanel from './git/HistoryPanel.svelte';
  import BranchesPanel from './git/BranchesPanel.svelte';
  import WorktreesPanel from './git/WorktreesPanel.svelte';
  import PrsPanel from './git/PrsPanel.svelte';
  import PrSheet from './git/PrSheet.svelte';
  import RunsPanel from './git/RunsPanel.svelte';
  import './git/git.css';

  type Tab = 'files' | 'history' | 'branches' | 'worktrees' | 'prs' | 'runs';

  let { id }: { id: string } = $props();
  let view = $derived(views[id]);
  let sessionCwd = $derived(view?.cwd ?? app.sessions.find((s) => s.id === id)?.cwd);
  /** Another worktree of this repository shown in place of the session's own (e.g. to resolve a merge there). */
  let override = $state<string | null>(null);
  let cwd = $derived(override ?? sessionCwd);
  let tab = $state<Tab>('files');
  let status = $state<GitStatusView | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let bump = $state(0);
  let resolving = $state(false);
  let mergeHint = $state<string | null>(null);
  let linked = $state<SessionPrLink | null>(null);
  let prNumber = $state<number | null>(null);
  /** Top level of the session's own worktree. */
  let sessionRoot = $state<string | null>(null);

  // Commands Devin ran in this session (tests, builds, linters) with their output.
  let runs = $derived((view?.items ?? []).filter((i): i is ToolItem => i.kind === 'tool' && i.toolKind === 'execute').reverse());
  let totals = $derived.by(() => {
    let a = 0;
    let r = 0;
    for (const f of status?.files ?? []) {
      a += f.added ?? 0;
      r += f.removed ?? 0;
    }
    return { a, r };
  });

  // A different session reuses this screen: start over.
  $effect(() => {
    id;
    untrack(() => {
      override = null;
      resolving = false;
      mergeHint = null;
      status = null;
      linked = null;
      prNumber = null;
      sessionRoot = null;
    });
  });

  async function load() {
    const dir = cwd;
    if (!dir || conn.status !== 'online') return;
    loading = true;
    try {
      const s: GitStatusView = await rpc('git.status', { cwd: dir });
      if (dir !== cwd) return;
      status = s;
      error = null;
      if (!override) sessionRoot = s.repoRoot;
      // Nothing left to resolve: leave the conflict view.
      if (resolving && !s.hasConflicts && !s.operation) resolving = false;
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }

  async function loadLink() {
    if (conn.status !== 'online') return;
    try {
      linked = (await rpc('git.sessionPrGet', { id })) ?? null;
    } catch {
      linked = null;
    }
  }

  /** Reload the status and the visible panel. */
  async function refresh() {
    bump += 1;
    await load();
  }

  // Opened directly (reload, deep link) the session has no timeline yet; load it for the command history.
  $effect(() => {
    const sid = id;
    conn.generation;
    if (conn.status !== 'online') return;
    untrack(() => {
      if (!views[sid]?.ready) openSession(sid, app.sessions.find((s) => s.id === sid)?.cwd).catch(() => {});
    });
  });

  // Refresh when the screen opens, on reconnect, and whenever the agent finishes a step.
  let toolsDone = $derived((view?.items ?? []).filter((i) => i.kind === 'tool' && (i.status === 'completed' || i.status === 'failed')).length);
  /** Changes whenever panels should reload their lists. */
  let stamp = $derived(`${conn.generation}:${toolsDone}:${bump}`);
  $effect(() => {
    cwd;
    conn.generation;
    toolsDone;
    untrack(load);
  });
  $effect(() => {
    id;
    conn.generation;
    untrack(loadLink);
  });

  function showWorktree(path: string, opts: { resolve: boolean; hint?: string }) {
    const next = path === sessionRoot || path === sessionCwd ? null : path;
    if (next !== override) {
      override = next;
      status = null;
    }
    mergeHint = opts.hint ?? null;
    resolving = opts.resolve;
    tab = 'files';
  }

  function leaveOverride() {
    override = null;
    status = null;
    resolving = false;
    mergeHint = null;
  }

  const tabs: { id: Tab; name: string }[] = [
    { id: 'files', name: 'Files' },
    { id: 'history', name: 'History' },
    { id: 'branches', name: 'Branches' },
    { id: 'worktrees', name: 'Worktrees' },
    { id: 'prs', name: 'PRs' },
    { id: 'runs', name: 'Runs' }
  ];
  let tabEls: Record<string, HTMLElement> = {};
  function pick(t: Tab) {
    tab = t;
    tabEls[t]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  const count = (t: Tab) => (t === 'files' ? (status?.files.length ?? 0) : t === 'runs' ? runs.length : 0);
  let gitTab = $derived(tab !== 'runs');
  let prState = $derived((linked?.state ?? '').toLowerCase());
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to={'#/s/' + encodeURIComponent(id)} label="Back to chat" />
    <div class="title">
      <b>Changes</b>
      <small>
        {#if status?.repo}
          <span class="sub"><Icon name="git" size={13} /> {status.detached ? 'detached' : (status.branch ?? 'detached')} · {status.files.length} file{status.files.length === 1 ? '' : 's'}
            {#if totals.a || totals.r}<span class="g-plus">+{totals.a}</span> <span class="g-minus">−{totals.r}</span>{/if}</span>
        {:else}<span class="sub">{basename(cwd)}</span>{/if}
        {#if linked}
          <button class="prchip" onclick={() => linked && (prNumber = linked.number)} aria-label="Pull request {linked.number}, {prState || 'linked'}">
            PR #{linked.number}{#if prState} · {prState}{/if}
          </button>
        {/if}
      </small>
    </div>
    <button class="iconbtn glass" onclick={refresh} aria-label="Refresh">{#if loading}<span class="spinner"></span>{:else}<Icon name="refresh" />{/if}</button>
  </header>

  <main class="scroller">
    <div class="column">
      <div class="segmented tabs" role="tablist" aria-label="Changes sections">
        {#each tabs as t (t.id)}
          <button role="tab" aria-selected={tab === t.id} class:on={tab === t.id} onclick={() => pick(t.id)} bind:this={tabEls[t.id]}>
            {t.name}{#if count(t.id)}<span class="n">{count(t.id)}</span>{/if}
          </button>
        {/each}
      </div>

      {#if override && gitTab}
        <div class="banner g-banner info">
          <span class="txt">Showing worktree <span class="mono">{shortPath(override, conn.info?.home)}</span></span>
          <button class="g-mini" onclick={leaveOverride}>Back to this session</button>
        </div>
      {/if}

      {#if gitTab}
        {#if !cwd}
          <div class="empty"><span class="spinner" style="margin:auto"></span></div>
        {:else if error && !status}
          <div class="empty"><h2>Could not read changes</h2><p>{error}</p></div>
        {:else if !status}
          <div class="empty"><span class="spinner" style="margin:auto"></span></div>
        {:else if !status.repo}
          <div class="empty"><h2>Not a git repository</h2><p>Changes, history, branches and pull requests are shown for projects tracked with git. File edits still appear inline in the chat.</p></div>
        {:else if tab === 'files'}
          <FilesPanel {cwd} {status} {refresh} bind:resolving bind:mergeHint terminal={() => go('#/s/' + encodeURIComponent(id) + '/terminal')} />
        {:else if tab === 'history'}
          <HistoryPanel {cwd} {stamp} active />
        {:else if tab === 'branches'}
          <BranchesPanel {cwd} {status} {stamp} {refresh} active />
        {:else if tab === 'worktrees'}
          <WorktreesPanel {cwd} {sessionRoot} {stamp} {refresh} active onopen={showWorktree} />
        {:else if tab === 'prs'}
          <PrsPanel
            {cwd}
            sessionId={id}
            {status}
            {stamp}
            {refresh}
            active
            {linked}
            openPr={(n) => (prNumber = n)}
            onlinkchange={(l) => (linked = l)}
          />
        {/if}
      {/if}
      <!-- Stays mounted so a running command keeps streaming while another tab is open. -->
      <div class="runs-tab" hidden={tab !== 'runs'}>
        <RunsPanel {id} cwd={sessionCwd} {runs} />
      </div>
    </div>
  </main>
</div>

{#if cwd}
  <PrSheet cwd={linked && prNumber === linked.number ? linked.cwd : cwd} sessionId={id} bind:number={prNumber} {linked} onlinkchange={(l) => (linked = l)} />
{/if}

<style>
  .column {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    max-width: var(--column);
    margin-inline: auto;
    padding: 8px calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .tabs {
    flex: none;
    margin-bottom: 16px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    scroll-padding-inline: 12px;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tabs button {
    flex: 1 0 auto;
    padding: 0 13px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .tabs .n {
    margin-left: 5px;
    font-size: 12px;
    color: var(--text-3);
  }
  .tabs button.on .n {
    color: var(--text-2);
  }
  .sub {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .prchip {
    flex: none;
    height: 22px;
    padding: 0 9px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .runs-tab {
    display: contents;
  }
  .runs-tab[hidden] {
    display: none;
  }
</style>
