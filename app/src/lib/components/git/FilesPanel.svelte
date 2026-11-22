<script lang="ts">
  import { untrack } from 'svelte';
  import { rpc, errorText } from '#lib/api.svelte.ts';
  import type { ChangedFile, DiffRow, GitStatusView } from '#lib/types.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import { parseDiff, basename } from '#lib/format.ts';
  import Icon from '../Icon.svelte';
  import DiffRows from '../DiffRows.svelte';
  import StatusCard from './StatusCard.svelte';
  import CommitBox from './CommitBox.svelte';
  import ConflictsPanel from './ConflictsPanel.svelte';
  import ConfirmSheet from './ConfirmSheet.svelte';
  import { Busy, ext, fileKind, fileLetter, plural, type ConfirmRequest } from './git.svelte.ts';

  type Side = 'staged' | 'unstaged';

  let {
    cwd,
    status,
    refresh,
    resolving = $bindable(false),
    mergeHint = $bindable(null),
    terminal
  }: {
    cwd: string;
    status: GitStatusView;
    refresh: () => Promise<void>;
    resolving?: boolean;
    mergeHint?: string | null;
    terminal: () => void;
  } = $props();

  // One index-changing action at a time: concurrent `git add`/`reset` calls would fight over index.lock.
  const busy = new Busy();
  let pending = $state<string | null>(null);
  let ask = $state<ConfirmRequest | null>(null);
  let openKey = $state<string | null>(null);
  let diffs = $state<Record<string, { rows?: DiffRow[]; truncated?: boolean; error?: string }>>({});

  const key = (side: Side, path: string) => `${side}:${path}`;

  async function loadDiff(k: string) {
    const i = k.indexOf(':');
    const side = k.slice(0, i) as Side;
    const path = k.slice(i + 1);
    try {
      const r = await rpc('git.diff', { cwd, path, scope: side });
      diffs[k] = { rows: parseDiff(r.diff), truncated: r.truncated };
    } catch (e) {
      diffs[k] = { error: errorText(e) };
    }
  }

  // Fresh diffs whenever the status changes.
  $effect(() => {
    status;
    untrack(() => {
      diffs = {};
      if (openKey) loadDiff(openKey);
    });
  });

  function toggle(k: string) {
    openKey = openKey === k ? null : k;
    if (openKey && !diffs[k]) loadDiff(k);
  }

  async function mutate(label: string, fn: () => Promise<unknown>) {
    if (pending) return;
    pending = label;
    await busy.run(label, async () => {
      await fn();
      await refresh();
    });
    pending = null;
  }

  const stage = (paths: string[]) => mutate('stage:' + paths.join('\0'), () => rpc('git.stage', { cwd, paths }));
  const unstage = (paths: string[]) => mutate('unstage:' + paths.join('\0'), () => rpc('git.unstage', { cwd, paths }));
  // With conflicts present, "add everything" would mark conflicted files resolved with their markers; list paths instead.
  const stageAll = () =>
    mutate('stage-all', () => (status.hasConflicts ? rpc('git.stage', { cwd, paths: status.unstaged.map((f) => f.path) }) : rpc('git.stage', { cwd, all: true })));
  const unstageAll = () =>
    mutate('unstage-all', () => (status.hasConflicts ? rpc('git.unstage', { cwd, paths: status.staged.map((f) => f.path) }) : rpc('git.unstage', { cwd, all: true })));

  function discard(f: ChangedFile) {
    const untracked = f.status === 'untracked';
    ask = {
      title: untracked ? 'Delete new file?' : 'Discard changes?',
      message: untracked
        ? `${f.path} is not tracked by git. It will be deleted and cannot be recovered.`
        : `Unstaged changes to ${f.path} will be lost. Staged changes stay.`,
      confirmLabel: untracked ? 'Delete file' : 'Discard changes',
      run: () =>
        mutate('discard:' + f.path, async () => {
          await rpc('git.discard', { cwd, paths: [f.path], confirm: true });
          toast(untracked ? `Deleted ${basename(f.path)}` : `Discarded changes to ${basename(f.path)}`);
        })
    };
  }

  function abort() {
    const op = status.operation;
    if (!op) return;
    ask = {
      title: `Abort ${op}?`,
      message: `Stops the ${op} and returns ${status.branch ?? 'HEAD'} to where it was before. Conflict resolutions made so far are lost.`,
      confirmLabel: `Abort ${op}`,
      run: () =>
        mutate('abort', async () => {
          await rpc('git.abortConflict', { cwd, confirm: true });
          resolving = false;
          mergeHint = null;
          toast(`${op[0].toUpperCase()}${op.slice(1)} aborted`);
        })
    };
  }

  const opLabel = (op: string | null) => (op === 'merge' ? 'Merge' : op === 'rebase' ? 'Rebase' : op === 'cherry-pick' ? 'Cherry-pick' : 'Conflicts');
  let conflictCount = $derived(status.conflicted.length);
</script>

{#snippet fileRow(f: ChangedFile, side: Side)}
  {@const k = key(side, f.path)}
  <div class="g-item">
    <div class="g-row frow">
      <button class="fhead" onclick={() => toggle(k)} aria-expanded={openKey === k}>
        <span class="g-k {fileKind(f, side)}" title={f.status}>{fileLetter(f, side)}</span>
        <span class="g-main">
          <b>{basename(f.path)}</b>
          <small><span class="path mono"><bdi>{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</bdi></span></small>
        </span>
        <span class="g-nums">{#if f.binary}bin{:else if f.additions || f.deletions}<span class="g-plus">+{f.additions}</span> <span class="g-minus">−{f.deletions}</span>{/if}</span>
      </button>
      {#if side === 'staged'}
        <button class="g-mini icon" onclick={() => unstage([f.path])} disabled={pending !== null} aria-label="Unstage {f.path}">
          {#if pending === 'unstage:' + f.path}<span class="spinner"></span>{:else}<Icon name="minus" size={17} />{/if}
        </button>
      {:else}
        <button class="g-mini icon" onclick={() => stage([f.path])} disabled={pending !== null} aria-label="Stage {f.path}">
          {#if pending === 'stage:' + f.path}<span class="spinner"></span>{:else}<Icon name="plus" size={17} />{/if}
        </button>
      {/if}
    </div>
    {#if openKey === k}
      <div class="g-diffbox">
        {#if !diffs[k]}<div class="g-pad"><span class="spinner"></span></div>
        {:else if diffs[k].error}<div class="g-pad g-err">{diffs[k].error}</div>
        {:else if !diffs[k].rows?.length}<div class="g-pad muted">No text changes to show.</div>
        {:else}
          <DiffRows rows={diffs[k].rows ?? []} lang={ext(f.path)} />
          {#if diffs[k].truncated}<div class="g-pad muted">Diff truncated. Open the terminal for the full output.</div>{/if}
        {/if}
        {#if side === 'unstaged'}
          <div class="dfoot">
            <button class="g-mini danger" onclick={() => discard(f)} disabled={pending !== null}>
              <Icon name="trash" size={15} />
              {f.status === 'untracked' ? 'Delete file…' : 'Discard changes…'}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

{#if resolving}
  <ConflictsPanel {cwd} {status} {refresh} {terminal} onclose={() => (resolving = false)} />
{:else}
  <StatusCard
    {cwd}
    {status}
    {refresh}
    onconflicts={(hint) => {
      mergeHint = hint;
      resolving = true;
    }}
  />

  {#if status.operation || conflictCount}
    <div class="banner warn g-banner" role="status">
      <span class="txt">
        {opLabel(status.operation)}{status.operation ? ' in progress' : ''} ·
        {conflictCount ? plural(conflictCount, 'conflicted file') : status.operation === 'rebase' ? 'continue it in the terminal' : 'commit to finish'}
      </span>
      {#if conflictCount}<button class="g-mini" onclick={() => (resolving = true)}>Resolve</button>{/if}
      {#if status.operation}<button class="g-mini danger" onclick={abort} disabled={pending !== null}>Abort…</button>{/if}
    </div>
  {/if}

  {#if !status.staged.length && !status.unstaged.length && !conflictCount}
    <div class="empty quiet"><h2>No changes</h2><p>The working tree matches the last commit.</p></div>
  {/if}

  {#if status.staged.length}
    <div class="g-head">
      <div class="label">Staged · {status.staged.length}</div>
      <button class="g-mini" onclick={unstageAll} disabled={pending !== null}>
        {#if pending === 'unstage-all'}<span class="spinner"></span>{/if} Unstage all
      </button>
    </div>
    <div class="card g-list">
      {#each status.staged as f (f.path)}{@render fileRow(f, 'staged')}{/each}
    </div>
  {/if}

  {#if status.staged.length || status.operation}
    <CommitBox {cwd} {status} {refresh} suggested={mergeHint} />
  {/if}

  {#if status.unstaged.length}
    <div class="g-head">
      <div class="label">Changes · {status.unstaged.length}</div>
      <button class="g-mini" onclick={stageAll} disabled={pending !== null}>
        {#if pending === 'stage-all'}<span class="spinner"></span>{/if} Stage all
      </button>
    </div>
    <div class="card g-list">
      {#each status.unstaged as f (f.path)}{@render fileRow(f, 'unstaged')}{/each}
    </div>
  {/if}

  {#if !status.staged.length && !status.operation && status.unstaged.length}
    <p class="tip muted">Stage files with <Icon name="plus" size={13} /> to commit them.</p>
  {/if}
{/if}

<ConfirmSheet bind:request={ask} />

<style>
  .frow {
    padding: 0 10px 0 0;
    gap: 6px;
  }
  .fhead {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 8px 4px 8px 16px;
    text-align: left;
  }
  .dfoot {
    display: flex;
    justify-content: flex-end;
    padding: 8px 10px;
    border-top: 1px solid var(--line);
  }
  .quiet {
    margin: 8px auto;
  }
  .tip {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-size: 13px;
    margin: 12px 0 0;
  }
</style>
