<script lang="ts">
  import { untrack } from 'svelte';
  import { conn, rpc, errorText } from '#lib/api.svelte.ts';
  import type { DiffRow, GitBranch, GitWorktree, WorktreeCompare, WorktreeMergePreview, WorktreeMergeResult } from '#lib/types.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import { basename, parseDiff, shortPath } from '#lib/format.ts';
  import Icon from '../Icon.svelte';
  import Sheet from '../Sheet.svelte';
  import DiffRows from '../DiffRows.svelte';
  import ConfirmSheet from './ConfirmSheet.svelte';
  import { Busy, plural, taskSlug, type ConfirmRequest } from './git.svelte.ts';

  let {
    cwd,
    sessionRoot,
    stamp,
    active,
    refresh,
    onopen
  }: {
    cwd: string;
    sessionRoot: string | null;
    stamp: string;
    active: boolean;
    refresh: () => Promise<void>;
    /** Show the Files tab of the worktree at `path` (merge conflicts to resolve, or squashed changes to commit). */
    onopen: (path: string, opts: { resolve: boolean; hint?: string }) => void;
  } = $props();

  const busy = new Busy();
  let worktrees = $state<GitWorktree[] | null>(null);
  let branches = $state<GitBranch[]>([]);
  let error = $state<string | null>(null);
  let ask = $state<ConfirmRequest | null>(null);

  async function load() {
    if (conn.status !== 'online') return;
    try {
      const [w, b] = await Promise.all([rpc('git.worktrees', { cwd }), rpc('git.branches', { cwd })]);
      worktrees = w;
      branches = b;
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

  let localBranches = $derived(branches.filter((b) => !b.remote).map((b) => b.name));
  let usedBranches = $derived(new Set((worktrees ?? []).map((w) => w.branch).filter(Boolean)));
  let freeBranches = $derived(localBranches.filter((b) => !usedBranches.has(b)));
  let stale = $derived((worktrees ?? []).filter((w) => w.prunable).length);
  const home = $derived(conn.info?.home);
  const label = (w: GitWorktree) => w.branch ?? (w.head ? `detached at ${w.head.slice(0, 7)}` : 'detached');

  // New worktree
  let adding = $state(false);
  let mode = $state<'task' | 'branch'>('task');
  let task = $state('');
  let baseRef = $state('');
  let existing = $state('');
  let slug = $derived(taskSlug(task.trim()));

  function openAdd() {
    task = '';
    baseRef = '';
    existing = freeBranches[0] ?? '';
    mode = 'task';
    adding = true;
  }

  function add() {
    const params = mode === 'task' ? { taskSlug: slug, baseRef: baseRef.trim() || undefined } : { branch: existing };
    if (mode === 'task' ? !slug : !existing) return;
    return busy.run('add', async () => {
      const w: GitWorktree = await rpc('git.worktreeAdd', { cwd, ...params });
      adding = false;
      toast(`Worktree ready: ${shortPath(w.path, home)}`);
      await refresh();
    });
  }

  function startSession(w: GitWorktree) {
    return busy.run('session:' + w.path, async () => {
      const r = await rpc('sessions.create', { cwd: w.path });
      go('#/s/' + encodeURIComponent(r.id));
    });
  }

  // Compare
  let comparing = $state<GitWorktree | null>(null);
  let compareBase = $state('');
  let compare = $state<(WorktreeCompare & { rows: DiffRow[] }) | null>(null);
  let compareError = $state<string | null>(null);

  async function loadCompare() {
    const w = comparing;
    if (!w) return;
    compare = null;
    compareError = null;
    try {
      const r: WorktreeCompare = await rpc('git.worktreeCompare', { cwd, worktreePath: w.path, baseBranch: compareBase || undefined });
      if (comparing !== w) return;
      compare = { ...r, rows: parseDiff(r.diff, { files: true }) };
      compareBase = r.baseBranch;
    } catch (e) {
      if (comparing === w) compareError = errorText(e);
    }
  }
  function openCompare(w: GitWorktree) {
    comparing = w;
    compareBase = '';
    loadCompare();
  }

  // Merge
  let merging = $state<GitWorktree | null>(null);
  let mergeTarget = $state('');
  let preview = $state<WorktreeMergePreview | null>(null);
  let previewError = $state<string | null>(null);
  let squash = $state(false);
  let removeAfter = $state(false);

  async function loadPreview() {
    const w = merging;
    if (!w) return;
    preview = null;
    previewError = null;
    try {
      const r: WorktreeMergePreview = await rpc('git.worktreeMerge', { cwd, worktreePath: w.path, targetBranch: mergeTarget || undefined });
      if (merging !== w) return;
      preview = r;
      mergeTarget = r.targetBranch;
    } catch (e) {
      if (merging === w) previewError = errorText(e);
    }
  }
  function openMerge(w: GitWorktree) {
    merging = w;
    mergeTarget = '';
    squash = false;
    removeAfter = false;
    loadPreview();
  }

  function merge() {
    const w = merging;
    const p = preview;
    if (!w || !p) return;
    return busy.run('merge', async () => {
      const r: WorktreeMergeResult = await rpc('git.worktreeMerge', {
        cwd,
        worktreePath: w.path,
        targetBranch: p.targetBranch,
        squash: squash || undefined,
        removeAfter: (removeAfter && !squash) || undefined,
        confirm: true
      });
      merging = null;
      const target = worktrees?.find((x) => x.branch === p.targetBranch) ?? worktrees?.find((x) => x.isMain);
      const targetPath = r.status.repoRoot ?? target?.path ?? cwd;
      if (r.conflicts) {
        toast(`Merge stopped on ${plural(r.conflictFiles.length, 'conflict')}. Resolve them to finish.`, 'error');
        onopen(targetPath, { resolve: true, hint: `Merge branch '${p.branch ?? basename(w.path)}' into ${p.targetBranch}` });
      } else if (squash) {
        toast(`Changes from ${p.branch ?? 'the worktree'} are staged on ${p.targetBranch}. Commit them to finish.`);
        onopen(targetPath, { resolve: false });
      } else {
        toast(`Merged ${p.branch ?? 'worktree'} into ${p.targetBranch}${removeAfter ? ' and removed the worktree' : ''}`);      }
      await refresh();
    });
  }

  function remove(w: GitWorktree) {
    const dirty = w.hasUncommittedChanges;
    ask = {
      title: 'Remove worktree?',
      message: `Removes the checkout at ${shortPath(w.path, home)}.${dirty ? `\n\nIt has ${plural(w.dirtyCount, 'uncommitted change')}. They will be lost.` : ' Its commits stay on the branch.'}`,
      confirmLabel: 'Remove worktree',
      acknowledge: dirty ? `Delete ${plural(w.dirtyCount, 'uncommitted change')} for good` : undefined,
      option: w.branch ? { label: `Also delete branch ${w.branch}`, checked: false } : undefined,
      run: (deleteBranch) =>
        busy.run('remove:' + w.path, async () => {
          await rpc('git.worktreeRemove', {
            cwd,
            worktreePath: w.path,
            deleteBranch: deleteBranch || undefined,
            ...(dirty ? { force: true, confirmDirty: true } : {})
          });
          toast(`Removed ${basename(w.path)}`);
          await refresh();
        })
    };
  }

  function prune() {
    return busy.run('prune', async () => {
      worktrees = await rpc('git.worktreePrune', { cwd });
      toast('Pruned stale worktree entries');
      await refresh();
    });
  }
</script>

{#if error}
  <div class="card g-note"><h3>Could not list worktrees</h3><p>{error}</p></div>
{:else if !worktrees}
  <div class="g-loading"><span class="spinner"></span></div>
{:else}
  <p class="intro muted">Give each agent its own checkout and branch so parallel sessions never edit the same files.</p>
  <div class="g-head">
    <div class="label">Worktrees · {worktrees.length}</div>
    {#if stale}
      <button class="g-mini" onclick={prune} disabled={busy.is('prune')}>{#if busy.is('prune')}<span class="spinner"></span>{/if} Prune {stale}</button>
    {/if}
    <button class="g-mini" onclick={openAdd}><Icon name="plus" size={15} /> New</button>
  </div>
  <div class="card g-list">
    {#each worktrees as w (w.path)}
      <div class="g-item wt">
        <div class="whead">
          <span class="g-main">
            <b class="mono">{label(w)}</b>
            <small>
              {#if w.isMain}<span class="g-badge blue">main</span>{/if}
              {#if w.path === sessionRoot}<span class="g-badge green">this session</span>{/if}
              {#if w.dirtyCount}<span class="g-badge amber">{plural(w.dirtyCount, 'change')}</span>{/if}
              {#if w.locked}<span class="g-badge">locked</span>{/if}
              {#if w.prunable}<span class="g-badge red">missing</span>{/if}
              <span class="path mono"><bdi>{shortPath(w.path, home)}</bdi></span>
            </small>
          </span>
        </div>
        {#if !w.prunable && !w.bare}
          <div class="g-actions acts">
            <button class="g-mini" onclick={() => startSession(w)} disabled={busy.is('session:' + w.path)}>
              {#if busy.is('session:' + w.path)}<span class="spinner"></span>{:else}<Icon name="play" size={14} />{/if} Start session here
            </button>
            {#if !w.isMain}
              <button class="g-mini" onclick={() => openCompare(w)}><Icon name="diff" size={15} /> Compare</button>
              <button class="g-mini" onclick={() => openMerge(w)} disabled={!w.branch && !w.head}><Icon name="merge" size={15} /> Merge…</button>
              <button class="g-mini danger" onclick={() => remove(w)} disabled={busy.is('remove:' + w.path)}>
                {#if busy.is('remove:' + w.path)}<span class="spinner"></span>{:else}<Icon name="trash" size={15} />{/if} Remove
              </button>
            {/if}
          </div>
        {:else if w.prunable}
          <p class="gone muted">This checkout no longer exists on disk. Prune to clean up the entry.</p>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<Sheet bind:open={adding} title="New worktree">
  <form onsubmit={(e) => (e.preventDefault(), add())}>
    <div class="segmented mode" role="tablist">
      <button type="button" role="tab" aria-selected={mode === 'task'} class:on={mode === 'task'} onclick={() => (mode = 'task')}>New task</button>
      <button type="button" role="tab" aria-selected={mode === 'branch'} class:on={mode === 'branch'} onclick={() => (mode = 'branch')}>Existing branch</button>
    </div>
    {#if mode === 'task'}
      <label class="g-field">
        <span>Task name</span>
        <input class="g-input" bind:value={task} placeholder="Fix login redirect" autocomplete="off" />
        <small class="g-hint">{slug ? `Creates branch uniharn/${slug}` : 'Letters, numbers, - and _ become the branch name.'}</small>
      </label>
      <label class="g-field">
        <span>Base</span>
        <input class="g-input mono" bind:value={baseRef} list="g-wt-refs" placeholder="HEAD" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" />
        <small class="g-hint">Branch or commit to start from. Empty means the current commit.</small>
        <datalist id="g-wt-refs">{#each branches as b (b.name)}<option value={b.name}></option>{/each}</datalist>
      </label>
    {:else if freeBranches.length}
      <label class="g-field">
        <span>Branch</span>
        <select class="g-select mono" bind:value={existing}>
          {#each freeBranches as b (b)}<option value={b}>{b}</option>{/each}
        </select>
        <small class="g-hint">Only branches not already checked out in another worktree.</small>
      </label>
    {:else}
      <p class="muted none">Every local branch is already checked out in a worktree. Start a new task instead.</p>
    {/if}
    <button class="btn primary block" type="submit" disabled={busy.is('add') || (mode === 'task' ? !slug : !existing)}>
      {#if busy.is('add')}<span class="spinner"></span>{/if} Create worktree
    </button>
  </form>
</Sheet>

<Sheet bind:open={() => comparing !== null, (v) => !v && (comparing = null)} title={comparing ? `Compare ${label(comparing)}` : ''} tall>
  {#if comparing}
    <label class="g-field">
      <span>Against</span>
      <select class="g-select mono" bind:value={compareBase} onchange={loadCompare}>
        {#if compareBase && !localBranches.includes(compareBase)}<option value={compareBase}>{compareBase}</option>{/if}
        {#each localBranches.filter((b) => b !== comparing?.branch) as b (b)}<option value={b}>{b}</option>{/each}
      </select>
    </label>
    {#if compareError}
      <p class="g-err">{compareError}</p>
    {:else if !compare}
      <div class="g-loading"><span class="spinner"></span></div>
    {:else}
      <div class="g-stats">
        <span class="g-badge blue">{compare.ahead} ahead</span>
        <span class="g-badge amber">{compare.behind} behind</span>
        <span class="g-badge">{plural(compare.committedFiles.length, 'file')} committed</span>
      </div>
      {#if compare.uncommittedFiles.length}
        <div class="banner warn">
          {plural(compare.uncommittedFiles.length, 'uncommitted change')} in this worktree {compare.uncommittedFiles.length === 1 ? 'is' : 'are'} not included below. Commit them before merging.
        </div>
      {/if}
      {#if compare.committedFiles.length}
        <div class="label">Committed files</div>
        <div class="card g-list flatlist">
          {#each compare.committedFiles as f (f.path)}
            <div class="g-row frow">
              <span class="g-main"><span class="fpath mono"><bdi>{f.path}</bdi></span></span>
              <span class="g-nums">{#if f.binary}bin{:else}<span class="g-plus">+{f.additions}</span> <span class="g-minus">−{f.deletions}</span>{/if}</span>
            </div>
          {/each}
        </div>
        <div class="label">Diff</div>
        <div class="g-diffbox flat">
          <DiffRows rows={compare.rows} />
          {#if compare.truncated}<div class="g-pad muted">Diff truncated.</div>{/if}
        </div>
      {:else}
        <p class="muted none">No commits on {compare.branch ?? 'this worktree'} that {compare.baseBranch} doesn't have.</p>
      {/if}
    {/if}
  {/if}
</Sheet>

<Sheet bind:open={() => merging !== null, (v) => !v && !busy.is('merge') && (merging = null)} title={merging ? `Merge ${label(merging)}` : ''}>
  {#if merging}
    <label class="g-field">
      <span>Into</span>
      <select class="g-select mono" bind:value={mergeTarget} onchange={loadPreview} disabled={busy.is('merge')}>
        {#if mergeTarget && !localBranches.includes(mergeTarget)}<option value={mergeTarget}>{mergeTarget}</option>{/if}
        {#each localBranches.filter((b) => b !== merging?.branch) as b (b)}<option value={b}>{b}</option>{/each}
      </select>
    </label>
    {#if previewError}
      <div class="banner warn">{previewError}</div>
    {:else if !preview}
      <div class="g-loading"><span class="spinner"></span></div>
    {:else}
      <div class="g-stats">
        <span class="g-badge blue">{plural(preview.ahead, 'commit')} to merge</span>
        {#if preview.canFastForward}<span class="g-badge green">fast-forward</span>{:else}<span class="g-badge">merge commit</span>{/if}
        {#if preview.hasConflicts}<span class="g-badge red">{plural(preview.conflictFiles.length, 'conflict')}</span>{/if}
      </div>
      {#if preview.conflictCheckSupported === false}
        <p class="muted none">This git version can't check for conflicts ahead of time.</p>
      {/if}
      {#if preview.hasConflicts}
        <div class="banner warn conflicts">
          <div>
            These files will conflict. You can resolve them after merging:
            <ul class="mono">{#each preview.conflictFiles as f (f)}<li>{f}</li>{/each}</ul>
          </div>
        </div>
      {/if}
      {#if preview.ahead === 0}
        <p class="muted none">{preview.targetBranch} already has every commit from {preview.branch ?? 'this worktree'}.</p>
      {:else}
        <label class="g-switch">
          <span>Squash into one change</span>
          <input type="checkbox" role="switch" bind:checked={squash} />
        </label>
        <label class="g-switch">
          <span>Remove the worktree afterwards</span>
          <input type="checkbox" role="switch" bind:checked={removeAfter} disabled={squash} />
        </label>
        <button class="btn primary block" onclick={merge} disabled={busy.is('merge')}>
          {#if busy.is('merge')}<span class="spinner"></span>{/if} Merge into {preview.targetBranch}
        </button>
      {/if}
    {/if}
  {/if}
</Sheet>

<ConfirmSheet bind:request={ask} />

<style>
  .intro {
    font-size: 13.5px;
    margin: 0 6px 4px;
  }
  .wt {
    padding: 10px 12px 12px 16px;
  }
  .whead {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .acts .g-mini {
    min-height: 32px;
    font-size: 13px;
  }
  .gone {
    margin: 0;
    font-size: 13px;
  }
  .mode {
    margin-bottom: 16px;
  }
  .none {
    font-size: 13.5px;
    margin: 8px 4px 12px;
  }
  .flatlist {
    background: var(--fill);
    box-shadow: none;
  }
  .frow {
    min-height: 40px;
  }
  .fpath {
    display: block;
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .flat {
    margin: 0;
  }
  .conflicts {
    margin-bottom: 12px;
    align-items: flex-start;
  }
  .conflicts ul {
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .g-stats + .banner {
    margin-bottom: 12px;
  }
</style>
