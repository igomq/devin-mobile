<script lang="ts">
  import { untrack } from 'svelte';
  import { conn, rpc, errorText } from '#lib/api.svelte.ts';
  import type { GitBranch, GitStatusView } from '#lib/types.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import Icon from '../Icon.svelte';
  import Sheet from '../Sheet.svelte';
  import ConfirmSheet from './ConfirmSheet.svelte';
  import { Busy, isLocalChangesError, isNotMergedError, type ConfirmRequest } from './git.svelte.ts';

  let {
    cwd,
    status,
    stamp,
    active,
    refresh
  }: { cwd: string; status: GitStatusView; stamp: string; active: boolean; refresh: () => Promise<void> } = $props();

  const busy = new Busy();
  let branches = $state<GitBranch[] | null>(null);
  let error = $state<string | null>(null);
  let ask = $state<ConfirmRequest | null>(null);

  let creating = $state(false);
  let newName = $state('');
  let newFrom = $state('');
  let newCheckout = $state(true);

  async function load() {
    if (conn.status !== 'online') return;
    try {
      branches = await rpc('git.branches', { cwd });
      error = null;
    } catch (e) {
      error = errorText(e);
    }
  }
  $effect(() => {
    stamp;
    cwd;
    if (active) untrack(load);
  });

  let local = $derived((branches ?? []).filter((b) => !b.remote));
  let remote = $derived((branches ?? []).filter((b) => b.remote));

  function checkout(b: GitBranch) {
    if (b.current || busy.any) return;
    return busy.run(
      'checkout:' + b.name,
      async () => {
        const s = await rpc('git.checkout', { cwd, branch: b.name });
        toast(`Switched to ${s.branch ?? b.name}`);
        await refresh();
      },
      (e) => {
        if (!isLocalChangesError(e)) return false;
        toast(`Can't switch to ${b.name}: your local changes would be overwritten. Commit, stash or discard them first.`, 'error');
        return true;
      }
    );
  }

  function remove(b: GitBranch) {
    ask = {
      title: `Delete ${b.name}?`,
      message: `Deletes the local branch ${b.name}. Git refuses if it has commits that are not merged anywhere.`,
      confirmLabel: 'Delete branch',
      run: () =>
        busy.run(
          'delete:' + b.name,
          async () => {
            await rpc('git.deleteBranch', { cwd, name: b.name });
            toast(`Deleted ${b.name}`);
            await refresh();
          },
          (e) => {
            if (!isNotMergedError(e)) return false;
            // Offer the force delete once the first sheet has closed.
            setTimeout(() => forceRemove(b), 0);
            return true;
          }
        )
    };
  }

  function forceRemove(b: GitBranch) {
    ask = {
      title: `${b.name} is not fully merged`,
      message: `Force deleting ${b.name} throws away its commits that are not on any other branch.${b.subject ? `\n\nLast commit: ${b.subject}` : ''}`,
      confirmLabel: 'Force delete',
      run: () =>
        busy.run('delete:' + b.name, async () => {
          await rpc('git.deleteBranch', { cwd, name: b.name, force: true, confirmForce: true });
          toast(`Deleted ${b.name}`);
          await refresh();
        })
    };
  }

  function openCreate() {
    newName = '';
    newFrom = '';
    newCheckout = true;
    creating = true;
  }

  function create() {
    const name = newName.trim();
    if (!name) return;
    return busy.run('create', async () => {
      await rpc('git.createBranch', { cwd, name, from: newFrom.trim() || undefined, checkout: newCheckout });
      toast(newCheckout ? `Created and switched to ${name}` : `Created ${name}`);
      creating = false;
      await refresh();
    }, (e) => {
      if (!isLocalChangesError(e)) return false;
      toast(`Can't switch to the new branch: your local changes would be overwritten.`, 'error');
      return true;
    });
  }
</script>

{#snippet row(b: GitBranch)}
  <div class="g-row">
    <button class="pick" onclick={() => checkout(b)} disabled={b.current || busy.any} aria-label={b.current ? `${b.name} (current)` : `Check out ${b.name}`}>
      <span class="mark">
        {#if busy.is('checkout:' + b.name)}<span class="spinner"></span>
        {:else if b.current}<Icon name="check" size={18} />{/if}
      </span>
      <span class="g-main">
        <b class="mono">{b.name}</b>
        <small>
          {#if b.current}<span class="g-badge green">current</span>{/if}
          {#if b.upstream}<span class="mono">{b.upstream}</span>{/if}
          {#if b.ahead}<span class="g-badge blue">↑ {b.ahead}</span>{/if}
          {#if b.behind}<span class="g-badge amber">↓ {b.behind}</span>{/if}
          {#if b.subject}<span class="subj">{b.subject}</span>{/if}
        </small>
      </span>
    </button>
    {#if !b.remote && !b.current}
      <button class="g-mini icon danger" onclick={() => remove(b)} disabled={busy.any} aria-label="Delete {b.name}">
        {#if busy.is('delete:' + b.name)}<span class="spinner"></span>{:else}<Icon name="trash" size={16} />{/if}
      </button>
    {/if}
  </div>
{/snippet}

{#if error}
  <div class="card g-note"><h3>Could not list branches</h3><p>{error}</p></div>
{:else if !branches}
  <div class="g-loading"><span class="spinner"></span></div>
{:else}
  {#if status.operation}
    <div class="banner warn g-banner"><span class="txt">Finish or abort the {status.operation} before switching branches.</span></div>
  {/if}
  <div class="g-head">
    <div class="label">Local · {local.length}</div>
    <button class="g-mini" onclick={openCreate}><Icon name="plus" size={15} /> New branch</button>
  </div>
  {#if local.length}
    <div class="card g-list">{#each local as b (b.name)}{@render row(b)}{/each}</div>
  {:else}
    <p class="muted none">No local branches yet. Make a first commit to create one.</p>
  {/if}
  <div class="g-head"><div class="label">Remote · {remote.length}</div></div>
  {#if remote.length}
    <div class="card g-list">{#each remote as b (b.name)}{@render row(b)}{/each}</div>
    <p class="muted none">Tap a remote branch to check it out as a local tracking branch.</p>
  {:else}
    <p class="muted none">No remote branches. Fetch from the Files tab, or publish a branch first.</p>
  {/if}
{/if}

<Sheet bind:open={creating} title="New branch">
  <form onsubmit={(e) => (e.preventDefault(), create())}>
    <label class="g-field">
      <span>Name</span>
      <input class="g-input mono" bind:value={newName} placeholder="feature/my-change" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" />
    </label>
    <label class="g-field">
      <span>Start from</span>
      <input class="g-input mono" bind:value={newFrom} list="g-branch-refs" placeholder={status.branch ?? 'HEAD'} autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" />
      <small class="g-hint">A branch, tag or commit. Leave empty to start from the current commit.</small>
      <datalist id="g-branch-refs">{#each branches ?? [] as b (b.name)}<option value={b.name}></option>{/each}</datalist>
    </label>
    <label class="g-switch">
      <span>Switch to the new branch</span>
      <input type="checkbox" role="switch" bind:checked={newCheckout} />
    </label>
    <button class="btn primary block" type="submit" disabled={!newName.trim() || busy.is('create')}>
      {#if busy.is('create')}<span class="spinner"></span>{/if} Create branch
    </button>
  </form>
</Sheet>

<ConfirmSheet bind:request={ask} />

<style>
  .pick {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    min-height: 40px;
  }
  .pick:disabled {
    opacity: 1;
  }
  .mark {
    flex: none;
    width: 20px;
    display: grid;
    place-items: center;
    color: var(--green);
  }
  .subj {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .none {
    font-size: 13px;
    margin: 8px 6px 0;
  }
</style>
