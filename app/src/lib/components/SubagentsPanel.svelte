<script lang="ts">
  import { app, conn, refreshSubagents, rpc, views } from '#lib/api.svelte.ts';
  import { shortHarnessName } from '#lib/labels.ts';
  import { duration } from '#lib/format.ts';
  import type { SessionLink, SubagentEntry } from '#lib/types.ts';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import SubagentTranscript from './SubagentTranscript.svelte';

  let { sessionId, compact = false }: { sessionId: string; compact?: boolean } = $props();

  const linkEntry = (l: SessionLink): SubagentEntry => ({
    kind: 'delegate',
    id: l.id,
    parentSessionId: l.parentSessionId,
    childSessionId: l.childSessionId,
    harnessId: l.harnessId,
    title: l.task.split('\n')[0] || 'Subagent',
    description: null,
    task: l.task,
    cwd: l.cwd,
    worktree: l.worktree,
    branch: l.branch,
    model: l.model ?? null,
    status: l.status,
    state: null,
    capabilities: { prompt: {} },
    configOptions: [],
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    canMessage: true,
    canCancel: l.status === 'running',
  });

  let remote = $derived(app.subagents.filter((e) => e.parentSessionId === sessionId));
  let linked = $derived(
    app.links
      .filter((l) => l.kind === 'delegate' && l.parentSessionId === sessionId && !remote.some((e) => e.childSessionId === l.childSessionId))
      .map(linkEntry),
  );
  let entries = $derived([...remote, ...linked].sort((a, b) => b.updatedAt - a.updatedAt));
  let active = $derived(entries.filter((e) => isActive(e)));
  let done = $derived(entries.filter((e) => !isActive(e)));

  let sheet = $state(false);
  let selected = $state<SubagentEntry | null>(null);
  let urgent = $state('');
  let sending = $state(false);
  let notice = $state<string | null>(null);

  $effect(() => {
    const sid = sessionId;
    conn.generation;
    app.links.length;
    if (conn.status !== 'online') return;
    rpc('orchestration.list', { id: sid }).catch(() => {});
    refreshSubagents(sid).catch(() => []);
  });
  $effect(() => {
    if (selected && !entries.some((e) => e.childSessionId === selected?.childSessionId)) selected = null;
  });

  let now = $state(Date.now());
  $effect(() => {
    if (!entries.some(isActive)) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  const harnessName = (id: string) => app.harnesses.find((h) => h.id === id)?.name ?? id;
  function isActive(e: SubagentEntry) {
    const s = views[e.childSessionId]?.state.status;
    return e.status === 'running' || e.status === 'requires_action' || e.status === 'awaiting_permission' || s === 'running' || s === 'awaiting_permission';
  }
  function statusOf(e: SubagentEntry) {
    const s = views[e.childSessionId]?.state.status;
    if (e.status === 'requires_action' || s === 'awaiting_permission' || e.status === 'awaiting_permission') return { label: 'Needs approval', cls: 'err' };
    if (isActive(e)) return { label: 'Working', cls: 'run' };
    if (e.status === 'error' || e.status === 'failed') return { label: 'Error', cls: 'err' };
    if (e.status === 'done' || e.status === 'completed' || e.status === 'idle') return { label: e.status === 'idle' ? 'Idle' : 'Done', cls: 'done' };
    return { label: e.status || 'Unknown', cls: 'idle' };
  }
  const elapsed = (e: SubagentEntry) => duration((isActive(e) ? now : e.updatedAt) - e.createdAt);
  function configSummary(e: SubagentEntry) {
    const opts = e.configOptions ?? [];
    const pick = (re: RegExp) => opts.find((o) => re.test(`${o.id} ${o.name} ${o.category ?? ''}`) && o.currentValue !== undefined);
    const effort = pick(/reason|effort|thought|thinking/i);
    const fast = pick(/fast|speed|turbo|priority|tier/i);
    return [effort ? `${effort.name || effort.id}: ${String(effort.currentValue)}` : null, fast ? `${fast.name || fast.id}: ${String(fast.currentValue)}` : null].filter(Boolean).join(' · ');
  }
  function openEntry(e: SubagentEntry) {
    selected = e;
    urgent = '';
    notice = null;
  }
  async function sendUrgent() {
    if (!selected || !urgent.trim() || sending) return;
    sending = true;
    notice = null;
    try {
      const r = await rpc('subagents.message', { parentSessionId: sessionId, childSessionId: selected.childSessionId, text: urgent.trim() });
      notice = r?.delivery === 'parent' ? 'Sent through the parent session.' : r?.mode === 'steering' ? 'Steered into the running turn.' : 'Sent as a new prompt.';
      urgent = '';
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
    }
  }
  async function cancelSelected() {
    if (!selected) return;
    try {
      await rpc('session.cancel', { id: selected.childSessionId });
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    }
  }
</script>

{#if entries.length}
  {#if compact}
    <button class="iconbtn subagent-btn" onclick={() => (sheet = true)} aria-label={active.length ? `Subagents: ${active.length} active` : 'Subagents'} title="Subagents">
      <Icon name="subagents" />
      {#if active.length}<b class="badge">{active.length}</b>{/if}
    </button>
  {:else}
    <div class="subagents">
      <button class="shead" onclick={() => (sheet = true)}>
        <span class="label">Subagents</span>
        <span class="count">{entries.length}</span>
        {#if active.length}<span class="live">{active.length} active</span>{/if}
        <span class="chev"><Icon name="chevron" size={14} /></span>
      </button>
    </div>
  {/if}

  <Sheet bind:open={sheet} title="Subagents" tall>
    {#if !selected}
      <div class="sheet-body">
        {#if active.length}
          <div class="group">
            <div class="group-label">Active</div>
            {#each active as e (e.childSessionId)}
              {@const st = statusOf(e)}
              <button class="row" onclick={() => openEntry(e)}>
                <span class="dot {st.cls}"></span>
                <span class="main">
                  <span class="title">{e.title}</span>
                  <span class="meta">{shortHarnessName(harnessName(e.harnessId))}{#if e.model} · {e.model}{/if}{#if e.branch} · {e.branch}{/if}{#if e.worktree} · worktree{/if} · {elapsed(e)}</span>
                </span>
                <span class="st {st.cls}">{st.label}</span>
              </button>
            {/each}
          </div>
        {/if}
        {#if done.length}
          <div class="group">
            <div class="group-label">Done</div>
            {#each done as e (e.childSessionId)}
              {@const st = statusOf(e)}
              <button class="row" onclick={() => openEntry(e)}>
                <span class="dot {st.cls}"></span>
                <span class="main">
                  <span class="title">{e.title}</span>
                  <span class="meta">{shortHarnessName(harnessName(e.harnessId))}{#if e.model} · {e.model}{/if}{#if e.branch} · {e.branch}{/if}{#if e.worktree} · worktree{/if} · {elapsed(e)}</span>
                </span>
                <span class="st {st.cls}">{st.label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      {@const e = selected}
      {@const st = statusOf(e)}
      <div class="sheet-body detail">
        <button class="back" onclick={() => (selected = null)}><Icon name="back" size={16} /> All subagents</button>
        <div class="dhead">
          <div class="dot {st.cls}"></div>
          <div>
            <div class="dtitle">{e.title}</div>
            <div class="dmeta">{shortHarnessName(harnessName(e.harnessId))}{#if e.model} · {e.model}{/if} · {st.label} · {elapsed(e)}</div>
          </div>
        </div>
        {#if e.description || e.task}<p class="desc">{e.description ?? e.task}</p>{/if}
        <div class="facts">
          {#if e.cwd}<div><span>Folder</span><code>{e.cwd}</code></div>{/if}
          {#if e.branch}<div><span>Branch</span><code>{e.branch}</code></div>{/if}
          {#if e.worktree}<div><span>Worktree</span><code>{e.worktree}</code></div>{/if}
          {#if configSummary(e)}<div><span>Settings</span><code>{configSummary(e)}</code></div>{/if}
        </div>
        {#if e.kind === 'native'}<p class="note">Native harness subagent. Urgent messages are sent to the parent session with instructions to forward them; the harness does not accept direct client prompts for children.</p>{/if}
        <div class="urgent">
          <textarea rows="2" bind:value={urgent} placeholder="Urgent message to this subagent" disabled={sending}></textarea>
          <div class="urgent-row">
            <button class="btn" onclick={sendUrgent} disabled={sending || !urgent.trim() || conn.status !== 'online'}>{sending ? 'Sending…' : 'Send urgent'}</button>
            {#if e.canCancel}<button class="btn ghost" onclick={cancelSelected}>Cancel</button>{/if}
          </div>
          {#if notice}<div class="notice">{notice}</div>{/if}
        </div>
        <div class="transcript-wrap">
          <SubagentTranscript sessionId={e.childSessionId} cwd={e.cwd} />
        </div>
      </div>
    {/if}
  </Sheet>
{/if}

<style>
  /* Compact trigger: a bare icon button for the chat header's glass group, with an active-count badge. */
  .badge {
    position: absolute;
    top: 3px;
    right: 2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent, #fff);
    font: 700 10px/16px var(--mono);
    text-align: center;
    pointer-events: none;
  }
  .subagents {
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--bg-elev);
    overflow: hidden;
  }
  .shead {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 14px;
    color: var(--text-2);
  }
  .label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .count,
  .live {
    font: 600 11px var(--mono);
    color: var(--text-3);
    background: var(--fill);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .live {
    color: var(--ok, #2f9e5f);
  }
  .chev {
    margin-left: auto;
    color: var(--text-3);
  }
  .sheet-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 4px 14px 18px;
  }
  .group-label {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 8px 2px 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 8px;
    border-radius: 14px;
    text-align: left;
  }
  .row:active {
    background: var(--fill);
  }
  .main {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    color: var(--text);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    color: var(--text-3);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: var(--text-3);
    flex: none;
  }
  .dot.run {
    background: var(--ok, #2f9e5f);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok, #2f9e5f) 18%, transparent);
  }
  .dot.done {
    background: var(--text-3);
  }
  .dot.err {
    background: var(--err, #d34f4f);
  }
  .dot.idle {
    background: var(--text-3);
  }
  .st {
    font: 600 11px var(--mono);
    color: var(--text-3);
    flex: none;
  }
  .st.run {
    color: var(--ok, #2f9e5f);
  }
  .st.done {
    color: var(--text-3);
  }
  .st.err {
    color: var(--err, #d34f4f);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 600;
  }
  .detail {
    min-height: 0;
  }
  .dhead {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .dtitle {
    font-size: 17px;
    font-weight: 700;
  }
  .dmeta {
    color: var(--text-3);
    font-size: 12px;
    margin-top: 2px;
  }
  .desc {
    color: var(--text-2);
    font-size: 13px;
    white-space: pre-wrap;
  }
  .facts {
    display: grid;
    gap: 6px;
  }
  .facts div {
    display: grid;
    grid-template-columns: 72px 1fr;
    gap: 8px;
    font-size: 12px;
  }
  .facts span {
    color: var(--text-3);
  }
  .facts code {
    color: var(--text-2);
    font: 11px var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    color: var(--text-3);
    font-size: 12px;
  }
  .urgent {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .urgent textarea {
    width: 100%;
    resize: vertical;
    border-radius: 14px;
    border: 1px solid var(--line);
    background: var(--fill);
    color: var(--text);
    padding: 10px 12px;
    font: inherit;
  }
  .urgent-row {
    display: flex;
    gap: 8px;
  }
  .btn {
    height: 36px;
    padding: 0 14px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent, #fff);
    font-weight: 700;
    font-size: 13px;
  }
  .btn.ghost {
    background: var(--fill);
    color: var(--text-2);
  }
  .notice {
    color: var(--text-2);
    font-size: 12px;
  }
  .transcript-wrap {
    min-height: 260px;
    border: 1px solid var(--line);
    border-radius: 18px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>
