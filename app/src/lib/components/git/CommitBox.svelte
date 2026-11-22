<script lang="ts">
  import { untrack } from 'svelte';
  import { rpc } from '#lib/api.svelte.ts';
  import type { GitCommitDetail, GitStatusView } from '#lib/types.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import { Busy } from './git.svelte.ts';

  let {
    cwd,
    status,
    refresh,
    suggested = null
  }: { cwd: string; status: GitStatusView; refresh: () => Promise<void>; suggested?: string | null } = $props();

  const busy = new Busy();
  let message = $state('');
  let amend = $state(false);
  let prefilled = $state<string | null>(null);

  // Finishing a merge or cherry-pick: offer a message once the operation is waiting for its commit.
  let finishing = $derived((status.operation === 'merge' || status.operation === 'cherry-pick') && !status.hasConflicts);
  $effect(() => {
    const op = status.operation;
    const text = op === 'merge' ? (suggested ?? `Merge into ${status.branch ?? 'HEAD'}`) : null;
    untrack(() => {
      if (text && (!message.trim() || message === prefilled)) {
        message = text;
        prefilled = text;
      } else if (!op && prefilled && message === prefilled) {
        message = '';
        prefilled = null;
      }
    });
  });

  let canCommit = $derived(
    Boolean(message.trim()) && !status.hasConflicts && status.operation !== 'rebase' && (status.staged.length > 0 || amend || finishing) && !busy.any
  );

  async function toggleAmend() {
    amend = !amend;
    if (!amend || message.trim()) return;
    // Amending usually keeps the last message; start from it.
    const last: GitCommitDetail | undefined = await busy.run('last', () => rpc('git.commitShow', { cwd, hash: 'HEAD' }));
    if (amend && !message.trim() && last) message = last.body ? `${last.subject}\n\n${last.body}` : last.subject;
  }

  function commit() {
    if (!canCommit) return;
    return busy.run('commit', async () => {
      const r = await rpc('git.commit', { cwd, message: message.trim(), amend: amend || undefined });
      toast(`${amend ? 'Amended' : 'Committed'} ${r.hash.slice(0, 7)} · ${r.subject}`);
      message = '';
      prefilled = null;
      amend = false;
      await refresh();
    });
  }
</script>

<form class="card commit" onsubmit={(e) => (e.preventDefault(), commit())}>
  {#if status.operation === 'rebase'}
    <p class="note">A rebase is in progress. After resolving conflicts, continue it in the terminal with <code>git rebase --continue</code>, or abort it above.</p>
  {:else}
    <textarea
      class="g-textarea"
      bind:value={message}
      placeholder={finishing ? 'Merge commit message' : status.staged.length ? 'Commit message' : 'Stage files to commit them'}
      aria-label="Commit message"
      rows="3"
      onkeydown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), commit())}
    ></textarea>
    <div class="row">
      {#if finishing}
        <span class="amend"></span>
      {:else}
        <label class="g-switch amend">
          <input type="checkbox" role="switch" checked={amend} onchange={toggleAmend} disabled={!status.head} />
          <span>Amend last commit</span>
        </label>
      {/if}
      <button class="btn primary" type="submit" disabled={!canCommit}>
        {#if busy.is('commit')}<span class="spinner"></span>{/if}
        {finishing ? 'Commit merge' : amend ? 'Amend' : status.staged.length ? `Commit ${status.staged.length}` : 'Commit'}
      </button>
    </div>
  {/if}
</form>

<style>
  .commit {
    padding: 10px;
    margin-top: 10px;
  }
  .commit .g-textarea {
    background: var(--fill);
    border-color: transparent;
    min-height: 84px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
  }
  .amend {
    flex: 1;
    flex-direction: row-reverse;
    justify-content: flex-end;
    margin: 0;
    padding-left: 4px;
    font-size: 14px;
    color: var(--text-2);
  }
  .row .btn {
    flex: none;
    min-height: 44px;
  }
  .note {
    margin: 4px 6px;
    font-size: 14px;
    color: var(--text-2);
  }
  .note code {
    font: 0.9em var(--mono);
    padding: 0.1em 0.35em;
    border-radius: 6px;
    background: var(--fill-2);
  }
</style>
