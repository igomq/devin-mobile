<script lang="ts">
  import { rpc } from '#lib/api.svelte.ts';
  import type { GitPullResult, GitStatusView } from '#lib/types.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import Icon from '../Icon.svelte';
  import Sheet from '../Sheet.svelte';
  import ConfirmSheet from './ConfirmSheet.svelte';
  import { Busy, type ConfirmRequest } from './git.svelte.ts';

  let {
    cwd,
    status,
    refresh,
    onconflicts
  }: {
    cwd: string;
    status: GitStatusView;
    refresh: () => Promise<void>;
    /** A pull stopped on conflicts; `hint` is a merge message to suggest. */
    onconflicts: (hint: string) => void;
  } = $props();

  const busy = new Busy();
  let more = $state(false);
  let ask = $state<ConfirmRequest | null>(null);

  let branch = $derived(status.detached ? null : status.branch);
  let remoteBusy = $derived(busy.is('fetch') || busy.is('pull') || busy.is('push'));
  /** Last useful line of git's own output, e.g. "Everything up-to-date". */
  const lastLine = (s: string | undefined) => (s ?? '').trim().split('\n').filter(Boolean).pop() ?? '';

  function fetch(prune = false) {
    more = false;
    return busy.run('fetch', async () => {
      await rpc('git.fetch', { cwd, prune: prune || undefined });
      toast(prune ? 'Fetched and pruned remote branches' : 'Fetched from all remotes');
      await refresh();
    });
  }

  function pull(rebase?: boolean) {
    more = false;
    return busy.run('pull', async () => {
      const r: GitPullResult = await rpc('git.pull', { cwd, rebase });
      await refresh();
      if (r.conflicts) {
        toast('Pull stopped on conflicts. Resolve them to finish.', 'error');
        onconflicts(`Merge branch '${status.upstream ?? 'upstream'}' into ${branch ?? 'HEAD'}`);
      } else toast(lastLine(r.output) || 'Pulled');
    });
  }

  function push(opts: { force?: boolean } = {}) {
    const publish = !status.upstream;
    return busy.run('push', async () => {
      const r = await rpc('git.push', {
        cwd,
        setUpstream: publish || undefined,
        ...(opts.force ? { force: true, confirmForce: true } : {})
      });
      toast(publish ? `Published ${branch}` : opts.force ? `Force pushed ${branch}` : lastLine(r.output) || 'Pushed');
      await refresh();
    });
  }

  function forcePush() {
    more = false;
    if (!branch) return;
    ask = {
      title: 'Force push?',
      message: `This replaces ${status.upstream ?? 'the remote branch'} with your local ${branch}. Commits on the remote that are not in your branch will be lost. The push is refused if the remote changed since your last fetch (--force-with-lease).`,
      confirmLabel: 'Force push',
      typeToConfirm: branch,
      run: () => push({ force: true })
    };
  }
</script>

<div class="card status">
  <div class="top">
    <span class="gi"><Icon name="git" size={18} /></span>
    <div class="g-main">
      {#if branch}
        <b class="mono">{branch}</b>
      {:else}
        <b>Detached HEAD{#if status.head}<span class="mono muted"> at {status.head.slice(0, 7)}</span>{/if}</b>
      {/if}
      <small>
        {#if status.detached}
          Create a branch to push or pull.
        {:else if status.upstream}
          <span class="mono">{status.upstream}</span>
          {#if status.ahead || status.behind}
            {#if status.ahead}<span class="g-badge blue" title="Commits to push">↑ {status.ahead}</span>{/if}
            {#if status.behind}<span class="g-badge amber" title="Commits to pull">↓ {status.behind}</span>{/if}
          {:else}
            <span>Up to date</span>
          {/if}
        {:else}
          Not published to a remote yet
        {/if}
      </small>
    </div>
  </div>
  <div class="acts">
    <button class="g-mini" onclick={() => fetch()} disabled={remoteBusy}>
      {#if busy.is('fetch')}<span class="spinner"></span>{:else}<Icon name="refresh" size={15} />{/if} Fetch
    </button>
    <button class="g-mini" onclick={() => pull()} disabled={remoteBusy || !status.upstream || status.detached}>
      {#if busy.is('pull')}<span class="spinner"></span>{:else}<Icon name="download" size={15} />{/if} Pull{#if status.behind}&nbsp;{status.behind}{/if}
    </button>
    <button class="g-mini" class:primary={!status.upstream && !status.detached} onclick={() => push()} disabled={remoteBusy || status.detached}>
      {#if busy.is('push')}<span class="spinner"></span>{:else}<Icon name="upload" size={15} />{/if}
      {status.upstream ? 'Push' : 'Publish branch'}{#if status.upstream && status.ahead}&nbsp;{status.ahead}{/if}
    </button>
    <button class="g-mini icon" onclick={() => (more = true)} aria-label="More remote actions" disabled={remoteBusy}><Icon name="more" size={18} /></button>
  </div>
</div>

<Sheet bind:open={more} title="Remote">
  <div class="card g-list menu">
    <button class="g-row" onclick={() => fetch(true)}>
      <Icon name="refresh" size={18} />
      <span class="g-main"><b>Fetch and prune</b><small>Also drop remote branches that were deleted on the server</small></span>
    </button>
    <button class="g-row" onclick={() => pull(true)} disabled={!status.upstream || status.detached}>
      <Icon name="download" size={18} />
      <span class="g-main"><b>Pull with rebase</b><small>Replay your local commits on top of {status.upstream ?? 'the upstream'}</small></span>
    </button>
    <button class="g-row danger" onclick={forcePush} disabled={!branch}>
      <Icon name="upload" size={18} />
      <span class="g-main"><b>Force push…</b><small>Overwrite the remote branch with your local history</small></span>
    </button>
  </div>
</Sheet>

<ConfirmSheet bind:request={ask} />

<style>
  .status {
    padding: 12px 12px 12px 14px;
    margin-bottom: 4px;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .gi {
    display: grid;
    place-items: center;
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 11px;
    background: var(--fill);
    color: var(--text-2);
  }
  .top b {
    font-size: 15px;
  }
  .acts {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .acts::-webkit-scrollbar {
    display: none;
  }
  .acts .g-mini:not(.icon) {
    flex: 1 0 auto;
  }
  .menu {
    background: var(--fill);
    box-shadow: none;
  }
  .menu .g-row {
    min-height: 60px;
  }
  .menu .danger {
    color: var(--red);
  }
</style>
