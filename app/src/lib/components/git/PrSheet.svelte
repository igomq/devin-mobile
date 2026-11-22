<script lang="ts">
  import { conn, rpc, errorText } from '#lib/api.svelte.ts';
  import type { DiffRow, PullRequestCheck, PullRequestView, SessionPrLink } from '#lib/types.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import { markdown, parseDiff } from '#lib/format.ts';
  import Icon from '../Icon.svelte';
  import Sheet from '../Sheet.svelte';
  import DiffRows from '../DiffRows.svelte';
  import { Busy, plural, relTime } from './git.svelte.ts';
  import { prStateBadge, reviewBadge } from './pr.ts';

  let {
    cwd,
    sessionId,
    number = $bindable(null),
    linked,
    onlinkchange
  }: {
    cwd: string;
    sessionId: string;
    /** The pull request to show; null closes the sheet. */
    number?: number | null;
    linked: SessionPrLink | null;
    onlinkchange: (link: SessionPrLink | null) => void;
  } = $props();

  const busy = new Busy();
  let pr = $state<PullRequestView | null>(null);
  let error = $state<string | null>(null);
  let diff = $state<{ rows: DiffRow[]; truncated: boolean } | null>(null);
  let diffError = $state<string | null>(null);
  let showDiff = $state(false);

  async function load(n: number) {
    pr = null;
    error = null;
    diff = null;
    diffError = null;
    showDiff = false;
    try {
      const r: PullRequestView = await rpc('git.prView', { cwd, number: n });
      if (number === n) pr = r;
    } catch (e) {
      if (number === n) error = errorText(e);
    }
  }

  $effect(() => {
    const n = number;
    if (n !== null && conn.status === 'online') load(n);
  });

  async function loadDiff() {
    showDiff = !showDiff;
    if (!showDiff || diff) return;
    const n = number;
    try {
      const r = await rpc('git.prDiff', { cwd, number: n });
      if (number === n) diff = { rows: parseDiff(r.diff, { files: true }), truncated: r.truncated };
    } catch (e) {
      if (number === n) diffError = errorText(e);
    }
  }

  let isLinked = $derived(linked !== null && linked.number === number);
  let url = $derived(pr?.url ?? (isLinked ? linked?.url : null));

  function link() {
    const p = pr;
    if (!p) return;
    return busy.run('link', async () => {
      const l: SessionPrLink = await rpc('git.sessionPrLink', {
        id: sessionId,
        link: { cwd, number: p.number, url: p.url, title: p.title, state: p.state, headRefName: p.headRefName, baseRefName: p.baseRefName }
      });
      onlinkchange(l);
      toast(`Linked PR #${p.number} to this session`);
    });
  }

  function unlink() {
    return busy.run('link', async () => {
      await rpc('git.sessionPrUnlink', { id: sessionId });
      onlinkchange(null);
      toast('Unlinked the pull request');
    });
  }

  const checkState = (c: PullRequestCheck) => {
    const v = (c.conclusion || c.state || c.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) return 'pass';
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) return 'fail';
    return 'pending';
  };
  let checks = $derived((Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : []).map((c) => ({ name: c.name || c.context || 'Check', state: checkState(c) })));
  let checkSummary = $derived({
    pass: checks.filter((c) => c.state === 'pass').length,
    fail: checks.filter((c) => c.state === 'fail').length,
    pending: checks.filter((c) => c.state === 'pending').length
  });
  let showChecks = $state(false);
  let files = $derived(Array.isArray(pr?.files) ? pr.files : []);
</script>

<Sheet bind:open={() => number !== null, (v) => !v && (number = null)} title={number !== null ? `Pull request #${number}` : ''} tall>
  {#if number !== null}
    {#if error}
      <div class="card g-note">
        <h3>Could not load the pull request</h3>
        <p>{error}</p>
        {#if isLinked && linked}<p><b>{linked.title}</b></p>{/if}
      </div>
    {:else if !pr}
      <div class="g-loading"><span class="spinner"></span></div>
    {:else}
      {@const st = prStateBadge(pr)}
      {@const rv = reviewBadge(pr.reviewDecision)}
      <h3 class="title">{pr.title}</h3>
      <div class="meta">
        <span class="g-badge {st.cls}">{st.text}</span>
        {#if rv}<span class="g-badge {rv.cls}">{rv.text}</span>{/if}
        <span class="mono refs">{pr.headRefName} → {pr.baseRefName}</span>
      </div>
      <div class="meta">
        {#if pr.author?.login}<span>{pr.author.login}</span>{/if}
        <span>opened {relTime(pr.createdAt)}</span>
        <span class="g-nums"><span class="g-plus">+{pr.additions}</span> <span class="g-minus">−{pr.deletions}</span></span>
        <span>{plural(pr.changedFiles, 'file')}</span>
      </div>
    {/if}

    <div class="g-actions bar">
      {#if url}<a class="g-mini" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={15} /> Open on GitHub</a>{/if}
      {#if isLinked}
        <button class="g-mini" onclick={unlink} disabled={busy.is('link')}>{#if busy.is('link')}<span class="spinner"></span>{:else}<Icon name="x" size={15} />{/if} Unlink</button>
      {:else if pr}
        <button class="g-mini" onclick={link} disabled={busy.is('link')}>{#if busy.is('link')}<span class="spinner"></span>{:else}<Icon name="link" size={15} />{/if} Link to this session</button>
      {/if}
    </div>
    {#if pr && !isLinked && linked}
      <p class="hint muted">This session is linked to PR #{linked.number}. Linking replaces it.</p>
    {/if}

    {#if pr}
      {#if checks.length}
        <button class="card checks" onclick={() => (showChecks = !showChecks)} aria-expanded={showChecks}>
          <span class="g-main"><b>Checks</b></span>
          {#if checkSummary.fail}<span class="g-badge red">{checkSummary.fail} failing</span>{/if}
          {#if checkSummary.pending}<span class="g-badge amber">{checkSummary.pending} pending</span>{/if}
          {#if checkSummary.pass}<span class="g-badge green">{checkSummary.pass} passed</span>{/if}
          <span class="chev" class:open={showChecks}><Icon name="chevron" size={16} /></span>
        </button>
        {#if showChecks}
          <div class="card g-list flatlist">
            {#each checks as c, i (i)}
              <div class="g-row crow">
                <span class="cs {c.state}">{#if c.state === 'pass'}<Icon name="check" size={15} />{:else if c.state === 'fail'}<Icon name="x" size={15} />{:else}<span class="dotp"></span>{/if}</span>
                <span class="g-main"><span class="t cname">{c.name}</span></span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}

      <div class="label">Description</div>
      {#if pr.body?.trim()}
        <div class="card md body">{@html markdown(pr.body)}</div>
      {:else}
        <p class="muted none">No description.</p>
      {/if}

      {#if files.length}
        <div class="label">{plural(files.length, 'file')}</div>
        <div class="card g-list flatlist">
          {#each files as f (f.path)}
            <div class="g-row frow">
              <span class="g-main"><span class="fpath mono"><bdi>{f.path}</bdi></span></span>
              <span class="g-nums"><span class="g-plus">+{f.additions}</span> <span class="g-minus">−{f.deletions}</span></span>
            </div>
          {/each}
        </div>
      {/if}

      <button class="g-more" onclick={loadDiff} aria-expanded={showDiff}>{showDiff ? 'Hide diff' : 'Show diff'}</button>
      {#if showDiff}
        <div class="g-diffbox flat">
          {#if diffError}<div class="g-pad g-err">{diffError}</div>
          {:else if !diff}<div class="g-pad"><span class="spinner"></span></div>
          {:else if !diff.rows.length}<div class="g-pad muted">No text changes to show.</div>
          {:else}
            <DiffRows rows={diff.rows} />
            {#if diff.truncated}<div class="g-pad muted">Diff truncated. Open the pull request on GitHub for the rest.</div>{/if}
          {/if}
        </div>
      {/if}
    {/if}
  {/if}
</Sheet>

<style>
  .title {
    margin: 0 4px 8px;
    font-size: 18px;
    font-weight: 650;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    margin: 0 4px 8px;
    font-size: 13px;
    color: var(--text-2);
  }
  .refs {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .bar {
    margin: 6px 0 10px;
  }
  .hint {
    font-size: 12.5px;
    margin: -4px 4px 10px;
  }
  .checks {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 48px;
    padding: 8px 14px;
    margin-top: 6px;
    background: var(--fill);
    box-shadow: none;
    text-align: left;
  }
  .chev {
    display: grid;
    color: var(--text-3);
    transition: transform 0.2s var(--ease-out);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .flatlist {
    margin-top: 6px;
    background: var(--fill);
    box-shadow: none;
  }
  .crow,
  .frow {
    min-height: 40px;
  }
  .cname {
    font-size: 13.5px !important;
    font-weight: 500 !important;
  }
  .cs {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
  }
  .cs.pass {
    color: var(--green);
  }
  .cs.fail {
    color: var(--red);
  }
  .dotp {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--amber);
  }
  .body {
    padding: 14px 16px;
    font-size: 14.5px;
    background: var(--fill);
    box-shadow: none;
  }
  .none {
    font-size: 13.5px;
    margin: 0 6px;
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
</style>
