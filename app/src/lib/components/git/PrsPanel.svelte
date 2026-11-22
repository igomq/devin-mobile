<script lang="ts">
  import { untrack } from 'svelte';
  import { conn, rpc, errorText } from '#lib/api.svelte.ts';
  import type { CreatedPullRequest, GhStatus, GitBranch, GitCommit, GitStatusView, PrStateFilter, PullRequestSummary, SessionPrLink } from '#lib/types.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import Icon from '../Icon.svelte';
  import Sheet from '../Sheet.svelte';
  import ConfirmSheet from './ConfirmSheet.svelte';
  import { Busy, plural, relTime, type ConfirmRequest } from './git.svelte.ts';
  import { prStateBadge, reviewBadge } from './pr.ts';

  let {
    cwd,
    sessionId,
    status,
    stamp,
    active,
    refresh,
    openPr,
    linked,
    onlinkchange
  }: {
    cwd: string;
    sessionId: string;
    status: GitStatusView;
    stamp: string;
    active: boolean;
    refresh: () => Promise<void>;
    openPr: (n: number) => void;
    linked: SessionPrLink | null;
    onlinkchange: (link: SessionPrLink | null) => void;
  } = $props();

  const busy = new Busy();
  let gh = $state<GhStatus | null>(null);
  let ghError = $state<string | null>(null);
  let ghFor = '';
  let filter = $state<PrStateFilter>('open');
  let prs = $state<PullRequestSummary[] | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let ask = $state<ConfirmRequest | null>(null);

  let ready = $derived(Boolean(gh?.ghInstalled && gh.authenticated && gh.isGitHubRepo));

  async function checkGh() {
    ghFor = `${cwd}|${conn.generation}`;
    gh = null;
    ghError = null;
    try {
      gh = await rpc('git.prStatus', { cwd });
    } catch (e) {
      ghError = errorText(e);
    }
  }

  async function loadList() {
    if (!ready) return;
    const f = filter;
    loading = true;
    try {
      const r: PullRequestSummary[] = await rpc('git.prList', { cwd, state: f, limit: 50 });
      if (filter === f) {
        prs = r;
        error = null;
      }
    } catch (e) {
      if (filter === f) error = errorText(e);
    } finally {
      loading = false;
    }
  }

  // GitHub CLI availability: checked once per project and connection (it runs `gh` twice on the gateway).
  $effect(() => {
    const key = `${cwd}|${conn.generation}`;
    if (!active || conn.status !== 'online') return;
    untrack(() => {
      if (ghFor !== key) checkGh();
    });
  });
  $effect(() => {
    stamp;
    filter;
    if (active && ready) untrack(loadList);
  });

  function setFilter(f: PrStateFilter) {
    if (filter === f) return;
    filter = f;
    prs = null;
  }

  // Create PR
  let creating = $state(false);
  let title = $state('');
  let body = $state('');
  let base = $state('');
  let draft = $state(false);
  let pushFirst = $state(true);
  let bases = $state<string[]>([]);

  let branch = $derived(status.detached ? null : status.branch);

  async function openCreate() {
    title = '';
    body = '';
    draft = false;
    pushFirst = true;
    creating = true;
    const [log, list] = await Promise.all([
      rpc('git.log', { cwd, limit: 1 }).catch(() => [] as GitCommit[]),
      rpc('git.branches', { cwd }).catch(() => [] as GitBranch[])
    ]);
    if (!title) title = (log as GitCommit[])[0]?.subject ?? '';
    const names = new Set<string>();
    for (const b of list as GitBranch[]) names.add(b.remote ? b.name.replace(/^[^/]+\//, '') : b.name);
    names.delete(branch ?? '');
    names.delete('HEAD');
    bases = [...names].sort();
    if (!base || !names.has(base)) base = ['main', 'master'].find((n) => names.has(n)) ?? bases[0] ?? '';
  }

  let canCreate = $derived(Boolean(branch && title.trim() && base.trim() && base.trim() !== branch) && !busy.is('create'));

  function submit() {
    if (!canCreate || !branch) return;
    if (!status.upstream) {
      ask = {
        title: `Publish ${branch}?`,
        message: `${branch} isn't on the remote yet. Push it and set its upstream, then open the pull request?`,
        confirmLabel: 'Push and create',
        danger: false,
        run: () => create(true)
      };
      return;
    }
    return create(false);
  }

  function create(publish: boolean) {
    const head = branch;
    if (!head) return Promise.resolve();
    return busy.run('create', async () => {
      if (publish) await rpc('git.push', { cwd, setUpstream: true });
      else if (pushFirst && status.ahead > 0) await rpc('git.push', { cwd });
      const pr: CreatedPullRequest = await rpc('git.prCreate', { cwd, title: title.trim(), body, base: base.trim(), draft: draft || undefined });
      creating = false;
      toast(`Opened PR #${pr.number}`);
      try {
        const l: SessionPrLink = await rpc('git.sessionPrLink', {
          id: sessionId,
          link: { cwd, number: pr.number, url: pr.url, title: pr.title, state: pr.state, headRefName: pr.headRefName, baseRefName: pr.baseRefName }
        });
        onlinkchange(l);
      } catch (e) {
        toast(`PR created, but linking it to this session failed: ${errorText(e)}`, 'error');
      }
      filter = 'open';
      await refresh();
      openPr(pr.number);
    });
  }
</script>

{#if ghError}
  <div class="card g-note">
    <h3>Could not check GitHub</h3>
    <p>{ghError}</p>
    <button class="btn" onclick={checkGh}>Try again</button>
  </div>
{:else if !gh}
  <div class="g-loading"><span class="spinner"></span></div>
{:else if !gh.isGitHubRepo}
  <div class="card g-note">
    <h3>Not a GitHub repository</h3>
    <p>Pull requests work for projects with a github.com remote. This repository has none{gh.remoteUrl ? '' : ' configured'}.</p>
    <button class="btn" onclick={checkGh}>Check again</button>
  </div>
{:else if !gh.ghInstalled}
  <div class="card g-note">
    <h3>GitHub CLI not installed</h3>
    <p>Pull requests go through the GitHub CLI on the gateway host. Install <code>gh</code> from cli.github.com there, then run <code>gh auth login</code>.</p>
    <button class="btn" onclick={checkGh}>Check again</button>
  </div>
{:else if !gh.authenticated}
  <div class="card g-note">
    <h3>GitHub CLI not signed in</h3>
    <p>Run <code>gh auth login</code> on the gateway host, then check again.</p>
    <button class="btn" onclick={checkGh}>Check again</button>
  </div>
{:else}
  <div class="g-head">
    <div class="label mono">{gh.repoSlug}</div>
    <button class="g-mini" onclick={openCreate} disabled={!branch}><Icon name="plus" size={15} /> Create PR</button>
  </div>
  <div class="segmented filter" role="tablist">
    {#each [['open', 'Open'], ['merged', 'Merged'], ['closed', 'Closed']] as [f, name] (f)}
      <button role="tab" aria-selected={filter === f} class:on={filter === f} onclick={() => setFilter(f as PrStateFilter)}>{name}</button>
    {/each}
  </div>
  {#if error}
    <div class="card g-note"><h3>Could not list pull requests</h3><p>{error}</p></div>
  {:else if !prs}
    <div class="g-loading"><span class="spinner"></span></div>
  {:else if prs.length === 0}
    <div class="empty"><h2>No {filter} pull requests</h2>{#if filter === 'open' && branch}<p>Create one for {branch} with Create PR.</p>{/if}</div>
  {:else}
    <div class="card g-list">
      {#each prs as p (p.number)}
        {@const rv = reviewBadge(p.reviewDecision)}
        {@const st = prStateBadge(p)}
        <button class="g-row" onclick={() => openPr(p.number)}>
          <span class="g-main">
            <span class="t"><span class="num">#{p.number}</span> {p.title}</span>
            <small>
              {#if p.isDraft || filter !== 'open'}<span class="g-badge {st.cls}">{st.text}</span>{/if}
              {#if linked?.number === p.number}<span class="g-badge blue">linked</span>{/if}
              {#if rv}<span class="g-badge {rv.cls}">{rv.text}</span>{/if}
              <span class="mono">{p.headRefName} → {p.baseRefName}</span>
              <span class="g-nums"><span class="g-plus">+{p.additions}</span> <span class="g-minus">−{p.deletions}</span></span>
              <span>{relTime(p.updatedAt)}</span>
            </small>
          </span>
          <span class="chev"><Icon name="chevron" size={16} /></span>
        </button>
      {/each}
    </div>
    {#if loading}<div class="g-loading small"><span class="spinner"></span></div>{/if}
  {/if}
{/if}

<Sheet bind:open={creating} title="Create pull request">
  <form onsubmit={(e) => (e.preventDefault(), submit())}>
    <p class="from muted">From <b class="mono">{branch}</b>{#if status.upstream && status.ahead} · {plural(status.ahead, 'unpushed commit')}{:else if !status.upstream} · not published yet{/if}</p>
    <label class="g-field">
      <span>Title</span>
      <input class="g-input" bind:value={title} placeholder="What this change does" autocomplete="off" />
    </label>
    <label class="g-field">
      <span>Description</span>
      <textarea class="g-textarea" bind:value={body} rows="5" placeholder="Why, how, and how to test it (Markdown)"></textarea>
    </label>
    <label class="g-field">
      <span>Base branch</span>
      <input class="g-input mono" bind:value={base} list="g-pr-bases" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" />
      <datalist id="g-pr-bases">{#each bases as b (b)}<option value={b}></option>{/each}</datalist>
      {#if base.trim() && base.trim() === branch}<small class="g-hint g-err">Choose a base other than the branch itself.</small>{/if}
    </label>
    <label class="g-switch">
      <span>Open as draft</span>
      <input type="checkbox" role="switch" bind:checked={draft} />
    </label>
    {#if status.upstream && status.ahead > 0}
      <label class="g-switch">
        <span>Push {plural(status.ahead, 'commit')} first</span>
        <input type="checkbox" role="switch" bind:checked={pushFirst} />
      </label>
    {/if}
    <button class="btn primary block" type="submit" disabled={!canCreate}>
      {#if busy.is('create')}<span class="spinner"></span>{/if} Create pull request
    </button>
  </form>
</Sheet>

<ConfirmSheet bind:request={ask} />

<style>
  .filter {
    margin-bottom: 12px;
  }
  .num {
    color: var(--text-3);
    font-weight: 500;
  }
  .chev {
    display: grid;
    color: var(--text-3);
  }
  .g-row .g-main .t {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .from {
    margin: 0 4px 14px;
    font-size: 14px;
  }
  .from b {
    color: var(--text);
  }
  .small {
    padding: 12px;
  }
</style>
