<script lang="ts">
  import { untrack } from 'svelte';
  import { conn, rpc, errorText } from '#lib/api.svelte.ts';
  import type { DiffRow, GitCommit, GitCommitDetail } from '#lib/types.ts';
  import { copyText, toast } from '#lib/ui.svelte.ts';
  import { parseDiff } from '#lib/format.ts';
  import Icon from '../Icon.svelte';
  import Sheet from '../Sheet.svelte';
  import DiffRows from '../DiffRows.svelte';
  import { plural, relTime } from './git.svelte.ts';

  let { cwd, stamp, active }: { cwd: string; stamp: string; active: boolean } = $props();

  const PAGE = 50;
  let limit = $state(PAGE);
  let commits = $state<GitCommit[] | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  let selected = $state<GitCommit | null>(null);
  let detail = $state<(GitCommitDetail & { rows: DiffRow[] }) | null>(null);
  let detailError = $state<string | null>(null);

  async function load() {
    if (conn.status !== 'online') return;
    loading = true;
    try {
      commits = await rpc('git.log', { cwd, limit });
      error = null;
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    stamp;
    cwd;
    limit;
    if (active) untrack(load);
  });

  async function open(c: GitCommit) {
    selected = c;
    detail = null;
    detailError = null;
    try {
      const d: GitCommitDetail = await rpc('git.commitShow', { cwd, hash: c.fullHash });
      if (selected === c) detail = { ...d, rows: parseDiff(d.diff, { files: true }) };
    } catch (e) {
      if (selected === c) detailError = errorText(e);
    }
  }

  /** "HEAD -> main" becomes "main"; tags and remote refs keep their own look. */
  function refBadges(refs: string[]) {
    return refs.map((r) => {
      if (r.startsWith('HEAD -> ')) return { text: r.slice(8), cls: 'green' };
      if (r === 'HEAD') return { text: 'HEAD', cls: 'green' };
      if (r.startsWith('tag: ')) return { text: r.slice(5), cls: 'amber' };
      if (r.includes('/')) return { text: r, cls: 'blue' };
      return { text: r, cls: '' };
    });
  }

  const fullDate = (t: number) => new Date(t).toLocaleString();
  const ext = (p: string) => (p.split('.').pop() ?? '').toLowerCase();
  // A commit diff covers many files; highlight only when they share one language.
  let lang = $derived.by(() => {
    const exts = new Set((detail?.files ?? []).map((f) => ext(f.path)));
    return exts.size === 1 ? [...exts][0] : '';
  });
</script>

{#if error}
  <div class="card g-note"><h3>Could not read history</h3><p>{error}</p></div>
{:else if !commits}
  <div class="g-loading"><span class="spinner"></span></div>
{:else if commits.length === 0}
  <div class="empty"><h2>No commits yet</h2><p>Commit your first change from the Files tab.</p></div>
{:else}
  <div class="card g-list">
    {#each commits as c (c.fullHash)}
      <button class="g-row" onclick={() => open(c)}>
        <span class="g-main">
          <span class="t">{c.subject || '(no message)'}</span>
          <small>
            <span class="mono">{c.hash}</span>
            <span>{c.author}</span>
            <span>{relTime(c.time)}</span>
            {#each refBadges(c.refs) as r}<span class="g-badge {r.cls}">{r.text}</span>{/each}
          </small>
        </span>
        <span class="chev"><Icon name="chevron" size={16} /></span>
      </button>
    {/each}
  </div>
  {#if commits.length >= limit}
    <button class="g-more" onclick={() => (limit += PAGE)} disabled={loading}>{#if loading}<span class="spinner"></span>{:else}Load more{/if}</button>
  {/if}
{/if}

<Sheet bind:open={() => selected !== null, (v) => !v && (selected = null)} title={selected ? selected.hash : ''} tall>
  {#if selected}
    <h3 class="subject">{selected.subject}</h3>
    <div class="meta">
      <span>{selected.author}</span>
      <span title={fullDate(selected.time)}>{relTime(selected.time)}</span>
      <button class="g-mini" onclick={() => selected && copyText(selected.fullHash).then((ok) => toast(ok ? 'Hash copied' : 'Could not copy', ok ? 'info' : 'error'))}>
        <Icon name="copy" size={14} /> <span class="mono">{selected.hash}</span>
      </button>
    </div>
    {#if detailError}
      <p class="g-err">{detailError}</p>
    {:else if !detail}
      <div class="g-loading"><span class="spinner"></span></div>
    {:else}
      {#if detail.body}<pre class="body">{detail.body}</pre>{/if}
      <div class="label">{plural(detail.files.length, 'file')} changed</div>
      <div class="card g-list files">
        {#each detail.files as f (f.path)}
          <div class="g-row frow">
            <span class="g-main"><span class="path mono"><bdi>{f.path}</bdi></span></span>
            <span class="g-nums">{#if f.binary}bin{:else}<span class="g-plus">+{f.additions}</span> <span class="g-minus">−{f.deletions}</span>{/if}</span>
          </div>
        {/each}
      </div>
      <div class="label">Diff</div>
      <div class="g-diffbox flat">
        {#if detail.rows.length}<DiffRows rows={detail.rows} {lang} />{:else}<div class="g-pad muted">No text changes to show.</div>{/if}
        {#if detail.truncated}<div class="g-pad muted">Diff truncated.</div>{/if}
      </div>
    {/if}
  {/if}
</Sheet>

<style>
  .chev {
    display: grid;
    color: var(--text-3);
  }
  .subject {
    margin: 0 4px 6px;
    font-size: 17px;
    font-weight: 650;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin: 0 4px 10px;
    font-size: 13px;
    color: var(--text-2);
  }
  .body {
    margin: 0 0 6px;
    padding: 12px 14px;
    border-radius: var(--r-md);
    background: var(--fill);
    font: 13.5px/1.5 var(--sans);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .files {
    background: var(--fill);
    box-shadow: none;
  }
  .frow {
    min-height: 40px;
  }
  .path {
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
</style>
