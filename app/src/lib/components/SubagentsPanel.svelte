<script lang="ts">
  import { untrack } from 'svelte';
  import { rpc, conn, app, views } from '#lib/api.svelte.ts';
  import { shortHarnessName } from '#lib/labels.ts';
  import { duration } from '#lib/format.ts';
  import type { SessionLink } from '#lib/types.ts';
  import Icon from './Icon.svelte';
  import SubagentTranscript from './SubagentTranscript.svelte';

  let { sessionId }: { sessionId: string } = $props();

  let links = $derived(app.links.filter((l) => l.parentSessionId === sessionId && l.kind === 'delegate'));
  let openIds = $state<Record<string, boolean>>({});

  // Default open while running, closed once finished; a manual toggle is kept.
  $effect(() => {
    for (const l of links) {
      if (untrack(() => openIds[l.childSessionId]) === undefined) openIds[l.childSessionId] = l.status === 'running';
    }
  });

  // Refresh this session's links (also keeps the session-list filter's data fresh).
  $effect(() => {
    const sid = sessionId;
    conn.generation;
    if (conn.status !== 'online') return;
    rpc('orchestration.list', { id: sid }).catch(() => {});
  });

  let now = $state(Date.now());
  $effect(() => {
    if (!links.some((l) => l.status === 'running')) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  const toggle = (l: SessionLink) => (openIds[l.childSessionId] = !openIds[l.childSessionId]);

  function statusOf(l: SessionLink) {
    const s = views[l.childSessionId]?.state.status;
    if (s === 'running' || s === 'awaiting_permission') return { label: s === 'awaiting_permission' ? 'Needs approval' : 'Working', cls: 'run' };
    if (s === 'idle') return { label: 'Idle', cls: 'idle' };
    if (l.status === 'error') return { label: 'Error', cls: 'err' };
    if (l.status === 'done') return { label: 'Done', cls: 'done' };
    return { label: 'Running', cls: 'run' };
  }
  const elapsed = (l: SessionLink) => duration((l.status === 'running' ? now : l.updatedAt) - l.createdAt);
  const harnessName = (id: string) => app.harnesses.find((h) => h.id === id)?.name ?? id;
</script>

{#if links.length}
  <div class="subagents">
    <div class="shead">
      <span class="label">Subagents</span>
      <span class="count">{links.length}</span>
    </div>
    {#each links as l (l.id)}
      {@const st = statusOf(l)}
      {@const open = !!openIds[l.childSessionId]}
      <div class="srow">
        <button class="sheadrow" onclick={() => toggle(l)} aria-expanded={open}>
          <span class="dot {st.cls}"></span>
          <span class="stext">{l.task.split('\n')[0]}</span>
          <span class="meta">{shortHarnessName(harnessName(l.harnessId))}{#if l.branch} · {l.branch}{/if} · {elapsed(l)}</span>
          <span class="chev" class:open><Icon name="chevron" size={14} /></span>
        </button>
        {#if open}
          <div class="tbody">
            <SubagentTranscript sessionId={l.childSessionId} cwd={l.cwd} />
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .subagents {
    flex: none;
    border-top: 1px solid var(--line);
    background: var(--bg);
    max-height: 62vh;
    overflow-y: auto;
  }
  .shead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px 4px;
    color: var(--text-2);
  }
  .label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .count {
    font: 600 11px var(--mono);
    color: var(--text-3);
    background: var(--fill);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .srow {
    border-top: 1px solid var(--line);
  }
  .sheadrow {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 44px;
    padding: 6px 16px;
    text-align: left;
  }
  .sheadrow:active {
    background: var(--fill);
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-3);
  }
  .dot.run {
    background: var(--green);
    animation: pulse 1.4s infinite ease-in-out;
  }
  .dot.idle {
    background: var(--text-3);
  }
  .dot.done {
    background: var(--green);
  }
  .dot.err {
    background: var(--red);
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  .stext {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
    color: var(--text);
  }
  .meta {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11.5px;
    color: var(--text-3);
  }
  .chev {
    flex: none;
    display: grid;
    color: var(--text-3);
    transition: transform 0.2s var(--ease-out);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .tbody {
    padding: 0 12px 10px;
  }
</style>
