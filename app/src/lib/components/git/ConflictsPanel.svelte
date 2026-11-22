<script lang="ts">
  import { untrack } from 'svelte';
  import { conn, rpc, errorText } from '#lib/api.svelte.ts';
  import type { ConflictFile, GitConflicts, GitOperation, GitStatusView } from '#lib/types.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import Icon from '../Icon.svelte';
  import Sheet from '../Sheet.svelte';
  import ConfirmSheet from './ConfirmSheet.svelte';
  import { Busy, hasConflictMarkers, plural, type ConfirmRequest } from './git.svelte.ts';

  let {
    cwd,
    status,
    refresh,
    onclose,
    terminal
  }: { cwd: string; status: GitStatusView; refresh: () => Promise<void>; onclose: () => void; terminal: () => void } = $props();

  const busy = new Busy();
  let data = $state<GitConflicts | null>(null);
  let error = $state<string | null>(null);
  let ask = $state<ConfirmRequest | null>(null);
  let editing = $state<ConflictFile | null>(null);
  let draft = $state('');

  async function load() {
    if (conn.status !== 'online') return;
    try {
      data = await rpc('git.conflicts', { cwd });
      error = null;
    } catch (e) {
      error = errorText(e);
    }
  }
  // Reload whenever the working tree status changes (each resolution refreshes it).
  $effect(() => {
    status;
    cwd;
    untrack(load);
  });

  const opName: Record<GitOperation, string> = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick' };
  let op = $derived(data?.operation ?? status.operation);
  let labels = $derived(
    op === 'rebase'
      ? { ours: 'Ours · branch being rebased onto', theirs: 'Theirs · your commit' }
      : op === 'cherry-pick'
        ? { ours: 'Ours · current branch', theirs: 'Theirs · picked commit' }
        : { ours: `Ours · ${status.branch ?? 'current'}`, theirs: 'Theirs · incoming' }
  );

  function resolve(path: string, strategy: 'ours' | 'theirs' | 'manual', content?: string) {
    return busy.run('resolve', async () => {
      const r = await rpc('git.resolveConflict', { cwd, path, strategy, content });
      toast(r.remaining ? `Resolved ${path} · ${plural(r.remaining, 'conflict')} left` : 'All conflicts resolved');
      if (strategy === 'manual') editing = null;
      await refresh();
    });
  }

  function edit(f: ConflictFile) {
    editing = f;
    draft = f.content;
  }

  function save() {
    const f = editing;
    if (!f) return;
    if (hasConflictMarkers(draft)) {
      ask = {
        title: 'Conflict markers remain',
        message: `${f.path} still contains <<<<<<<, ======= or >>>>>>> lines. Saving marks the file as resolved with those lines in it.`,
        confirmLabel: 'Save anyway',
        run: () => resolve(f.path, 'manual', draft)
      };
      return;
    }
    return resolve(f.path, 'manual', draft);
  }
</script>

<div class="g-head">
  <button class="g-mini" onclick={onclose}><Icon name="back" size={15} /> Files</button>
  <div class="label">{op ? `${opName[op]} in progress` : 'Conflicts'}{#if data}{` · ${plural(data.files.length, 'conflicted file')}`}{/if}</div>
</div>

{#if error}
  <div class="card g-note"><h3>Could not read conflicts</h3><p>{error}</p></div>
{:else if !data}
  <div class="g-loading"><span class="spinner"></span></div>
{:else if data.files.length === 0}
  <div class="card g-note">
    <h3>All conflicts resolved</h3>
    {#if op === 'rebase'}
      <p>Continue the rebase in the terminal with <code>git rebase --continue</code>.</p>
      <button class="btn" onclick={terminal}><Icon name="terminal" size={16} /> Open terminal</button>
    {:else if op}
      <p>Commit the result to finish the {opName[op].toLowerCase()}.</p>
      <button class="btn" onclick={onclose}>Review and commit</button>
    {:else}
      <button class="btn" onclick={onclose}>Back to files</button>
    {/if}
  </div>
{:else}
  {#each data.files as f (f.path)}
    <div class="card cfile">
      <div class="g-row fh">
        <span class="g-k conflict">!</span>
        <span class="g-main"><b>{f.path.split('/').pop()}</b><small><span class="path mono"><bdi>{f.path}</bdi></span></small></span>
      </div>
      {#if f.hunks.length}
        {#each f.hunks as h (h.index)}
          <div class="hunk">
            <div class="where">Lines {h.startLine}–{h.endLine}</div>
            <div class="side ours"><span>{labels.ours}</span><pre class="mono">{h.ours || '(empty)'}</pre></div>
            {#if h.base !== undefined}<div class="side base"><span>Base</span><pre class="mono">{h.base || '(empty)'}</pre></div>{/if}
            <div class="side theirs"><span>{labels.theirs}</span><pre class="mono">{h.theirs || '(empty)'}</pre></div>
          </div>
        {/each}
      {:else}
        <p class="nomark">No conflict markers in this file. It may be binary, or deleted on one side. Choose the version to keep.</p>
      {/if}
      <div class="g-actions acts">
        <button class="g-mini" disabled={busy.any} onclick={() => resolve(f.path, 'ours')}>Use ours</button>
        <button class="g-mini" disabled={busy.any} onclick={() => resolve(f.path, 'theirs')}>Use theirs</button>
        {#if f.content}<button class="g-mini" disabled={busy.any} onclick={() => edit(f)}><Icon name="edit" size={15} /> Edit</button>{/if}
      </div>
    </div>
  {/each}
{/if}

<Sheet bind:open={() => editing !== null, (v) => !v && !busy.any && (editing = null)} title={editing ? `Edit ${editing.path.split('/').pop()}` : ''} tall>
  {#if editing}
    <p class="hint">Keep the lines you want and delete the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>, <code>=======</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> markers.</p>
    <textarea class="g-textarea code" bind:value={draft} aria-label="File content" autocapitalize="off" autocorrect="off" spellcheck="false" wrap="off"></textarea>
    {#if hasConflictMarkers(draft)}<p class="warnline">Conflict markers are still present.</p>{/if}
    <div class="g-actions save">
      <button class="btn" onclick={() => (editing = null)} disabled={busy.any}>Cancel</button>
      <button class="btn primary" onclick={save} disabled={busy.any}>
        {#if busy.is('resolve')}<span class="spinner"></span>{/if} Save and mark resolved
      </button>
    </div>
  {/if}
</Sheet>

<ConfirmSheet bind:request={ask} />

<style>
  .cfile {
    overflow: hidden;
    margin-bottom: 12px;
  }
  .fh {
    min-height: 52px;
  }
  .hunk {
    margin: 0 10px 10px;
    border-radius: var(--r-md);
    background: var(--bg);
    overflow: hidden;
  }
  .where {
    padding: 6px 12px;
    font: 12px var(--mono);
    color: var(--text-3);
    background: color-mix(in srgb, var(--text) 4%, transparent);
  }
  .side {
    border-left: 3px solid var(--line-strong);
  }
  .side span {
    display: block;
    padding: 6px 10px 0;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-3);
  }
  .side pre {
    margin: 0;
    padding: 4px 10px 8px;
    font-size: 12px;
    line-height: 1.55;
    white-space: pre;
    overflow-x: auto;
  }
  .ours {
    border-left-color: var(--blue);
    background: color-mix(in srgb, var(--blue) 8%, transparent);
  }
  .theirs {
    border-left-color: var(--green);
    background: var(--add-bg);
  }
  .base {
    border-left-color: var(--text-3);
  }
  .nomark {
    margin: 0 16px 10px;
    font-size: 13.5px;
    color: var(--text-2);
  }
  .acts {
    padding: 0 10px 12px;
  }
  .hint {
    margin: 0 4px 10px;
    font-size: 13.5px;
    color: var(--text-2);
  }
  .hint code {
    font: 0.9em var(--mono);
  }
  .warnline {
    margin: 8px 4px 0;
    font-size: 13.5px;
    color: var(--amber);
  }
  .save {
    margin-top: 12px;
  }
  .save .btn {
    flex: 1;
    min-height: 46px;
  }
  .save .btn:not(.primary) {
    background: var(--fill);
  }
</style>
