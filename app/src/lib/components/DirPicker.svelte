<script lang="ts">
  import { untrack } from 'svelte';
  import { rpc, conn, app, errorText } from '#lib/api.svelte.ts';
  import { shortPath, basename } from '#lib/format.ts';
  import { isScratchPath } from '#lib/labels.ts';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  // onnoproject: offered first; starts the session in a fresh scratch folder the gateway creates.
  let { open = $bindable(false), onpick, onnoproject }: { open?: boolean; onpick?: (path: string) => void; onnoproject?: () => void } = $props();
  let listing = $state<{ path: string; parent: string | null; dirs: { name: string; git: boolean }[] } | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let browsing = $state(false);

  let recents = $derived.by(() => {
    const seen = new Map<string, unknown>();
    for (const s of app.sessions) if (s.cwd && !seen.has(s.cwd) && !isScratchPath(s.cwd, conn.info?.scratchDir)) seen.set(s.cwd, s.updatedAt);
    return [...seen.keys()].slice(0, 8);
  });
  let projects = $state<{ path: string; name: string; isGit: boolean }[]>([]);
  let others = $derived(projects.filter((p) => p.isGit && !recents.includes(p.path)).slice(0, 12));

  $effect(() => {
    if (open) {
      error = null;
      untrack(async () => {
        browsing = false;
        if (!recents.length && !projects.length) loading = true;
        try {
          projects = (await rpc('projects.list')).projects ?? [];
        } catch {}
        loading = false;
        // With nothing to offer but browsing, open the browser directly (unless "No project" is on offer).
        if (!recents.length && !others.length && !onnoproject) {
          browsing = true;
          if (!listing) load('~');
        }
      });
    }
  });

  async function load(path: string) {
    loading = true;
    error = null;
    try {
      listing = await rpc('fs.list', { path });
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }

  function pick(path: string) {
    open = false;
    onpick?.(path);
  }

  function noProject() {
    open = false;
    onnoproject?.();
  }
</script>

<Sheet bind:open title="Choose a project" tall>
  {#if !browsing}
    {#if onnoproject}
      <div class="group noproject">
        <button class="row" onclick={noProject}>
          <span class="ic"><Icon name="compose" size={18} /></span>
          <span class="main"><b>No project</b><small>Start in an empty scratch folder</small></span>
        </button>
      </div>
    {/if}
    {#if recents.length}
      <div class="label">Recent</div>
      <div class="group">
        {#each recents as p}
          <button class="row" onclick={() => pick(p)}>
            <span class="ic"><Icon name="folder" size={18} /></span>
            <span class="main"><b>{basename(p)}</b><small class="mono">{shortPath(p, conn.info?.home)}</small></span>
          </button>
        {/each}
      </div>
    {/if}
    {#if others.length}
      <div class="label">Repositories</div>
      <div class="group">
        {#each others as p}
          <button class="row" onclick={() => pick(p.path)}>
            <span class="ic"><Icon name="git" size={18} /></span>
            <span class="main"><b>{p.name}</b><small class="mono">{shortPath(p.path, conn.info?.home)}</small></span>
          </button>
        {/each}
      </div>
    {/if}
    <div class="group browse">
      <button class="row" onclick={() => ((browsing = true), load(listing?.path ?? '~'))}>
        <span class="ic"><Icon name="search" size={18} /></span>
        <span class="main"><b>Browse the VM…</b><small>Pick any directory</small></span>
        <span class="chev"><Icon name="chevron" size={18} /></span>
      </button>
    </div>
  {:else}
    <div class="crumb">
      <button class="up press" disabled={!listing?.parent} onclick={() => listing?.parent && load(listing.parent)} aria-label="Parent directory"><Icon name="back" size={18} /></button>
      <span class="mono path"><bdi>{shortPath(listing?.path ?? '', conn.info?.home) || '…'}</bdi></span>
      {#if loading}<span class="spinner"></span>{/if}
    </div>
    {#if error}<p class="err">{error}</p>{/if}
    <button class="btn primary block use" disabled={!listing} onclick={() => listing && pick(listing.path)}>
      Use {listing ? basename(listing.path) : ''}
    </button>
    <div class="group">
      {#each listing?.dirs ?? [] as d}
        <button class="row" onclick={() => listing && load(listing.path.replace(/\/$/, '') + '/' + d.name)}>
          <span class="ic"><Icon name={d.git ? 'git' : 'folder'} size={18} /></span>
          <span class="main"><b>{d.name}</b></span>
          <span class="chev"><Icon name="chevron" size={18} /></span>
        </button>
      {:else}
        {#if listing && !loading}<p class="muted none">No sub-folders here.</p>{/if}
      {/each}
    </div>
  {/if}
</Sheet>

<style>
  .label:first-child {
    margin-top: 4px;
  }
  .group {
    border-radius: var(--r-lg);
    background: var(--fill);
    overflow: hidden;
  }
  .noproject {
    margin-top: 4px;
  }
  .browse {
    margin-top: 22px;
  }
  .browse:first-child {
    margin-top: 4px;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 10px 14px 10px 16px;
    text-align: left;
    color: var(--text);
    transition: background-color 0.2s ease;
  }
  .row:active {
    background: var(--fill);
  }
  /* Inset hairline between rows, aligned with the row text. */
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50px;
    right: 0;
    height: 1px;
    background: var(--line);
  }
  .ic {
    flex: none;
    width: 22px;
    display: grid;
    place-items: center;
    color: var(--text-2);
  }
  .main {
    flex: 1;
    min-width: 0;
  }
  .row b {
    display: block;
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row small {
    display: block;
    font-size: 12px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    flex: none;
    display: grid;
    color: var(--text-3);
  }
  .crumb {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 0 12px;
  }
  .up {
    flex: none;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--fill);
  }
  .path {
    flex: 1;
    font-size: 13px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .use {
    margin-bottom: 14px;
  }
  .err {
    color: var(--red);
    font-size: 14px;
    margin: 0 4px 12px;
  }
  .none {
    margin: 0;
    padding: 16px;
    font-size: 14px;
  }
</style>
