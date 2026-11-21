<script lang="ts">
  import { untrack } from 'svelte';
  import { rpc, conn, app, errorText } from '#lib/api.svelte.ts';
  import { shortPath, basename } from '#lib/format.ts';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let { open = $bindable(false), onpick }: { open?: boolean; onpick?: (path: string) => void } = $props();
  let listing = $state<{ path: string; parent: string | null; dirs: { name: string; git: boolean }[] } | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let browsing = $state(false);

  let recents = $derived.by(() => {
    const seen = new Map<string, unknown>();
    for (const s of app.sessions) if (s.cwd && !seen.has(s.cwd)) seen.set(s.cwd, s.updatedAt);
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
        if (!recents.length && !others.length) {
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
</script>

<Sheet bind:open title="Choose a project" tall>
  {#if !browsing}
    {#if recents.length}<div class="label">Recent</div>{/if}
    {#each recents as p}
      <button class="row" onclick={() => pick(p)}>
        <span class="ic"><Icon name="folder" size={20} /></span>
        <span class="main"><b>{basename(p)}</b><small class="mono">{shortPath(p, conn.info?.home)}</small></span>
      </button>
    {/each}
    {#if others.length}<div class="label">Repositories</div>{/if}
    {#each others as p}
      <button class="row" onclick={() => pick(p.path)}>
        <span class="ic"><Icon name="git" size={20} /></span>
        <span class="main"><b>{p.name}</b><small class="mono">{shortPath(p.path, conn.info?.home)}</small></span>
      </button>
    {/each}
    <button class="row" onclick={() => ((browsing = true), load(listing?.path ?? '~'))}>
      <span class="ic"><Icon name="search" size={20} /></span>
      <span class="main"><b>Browse the VM…</b><small>Pick any directory</small></span>
      <Icon name="chevron" size={18} />
    </button>
  {:else}
    <div class="crumb">
      <button class="up" disabled={!listing?.parent} onclick={() => listing?.parent && load(listing.parent)} aria-label="Parent directory"><Icon name="back" size={18} /></button>
      <span class="mono path"><bdi>{shortPath(listing?.path ?? '', conn.info?.home) || '…'}</bdi></span>
      {#if loading}<span class="spinner"></span>{/if}
    </div>
    {#if error}<p class="err">{error}</p>{/if}
    <button class="btn primary block use" disabled={!listing} onclick={() => listing && pick(listing.path)}>
      Use {listing ? basename(listing.path) : ''}
    </button>
    <div class="list">
      {#each listing?.dirs ?? [] as d}
        <button class="row" onclick={() => listing && load(listing.path.replace(/\/$/, '') + '/' + d.name)}>
          <span class="ic"><Icon name={d.git ? 'git' : 'folder'} size={20} /></span>
          <span class="main"><b>{d.name}</b></span>
          <Icon name="chevron" size={18} />
        </button>
      {:else}
        {#if listing && !loading}<p class="muted none">No sub-folders here.</p>{/if}
      {/each}
    </div>
  {/if}
</Sheet>

<style>
  .label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    margin: 4px 2px 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    padding: 8px 4px;
    text-align: left;
    border-bottom: 1px solid var(--line);
    color: var(--text);
  }
  .row .ic {
    color: var(--text-2);
    display: grid;
  }
  .row .main {
    flex: 1;
    min-width: 0;
  }
  .row b {
    display: block;
    font-weight: 500;
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
  .crumb {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .up {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 10px;
    background: var(--bg-elev2);
  }
  .path {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .use {
    margin-bottom: 8px;
  }
  .err {
    color: var(--red);
    font-size: 14px;
  }
  .none {
    padding: 18px 4px;
    font-size: 14px;
  }
</style>
