<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { views, conn, openSession, leaveSession } from '#lib/api.svelte.ts';
  import { markdown } from '#lib/format.ts';
  import { fileUrlsToPaths } from '#lib/localImages.ts';
  import type { Item, TextItem, ToolItem } from '#lib/types.ts';
  import Icon from './Icon.svelte';
  import ToolCall from './ToolCall.svelte';

  let { sessionId, cwd }: { sessionId: string; cwd: string | null } = $props();

  let view = $derived(views[sessionId]);
  let st = $derived(view?.state);
  let busy = $derived(st?.status === 'running' || st?.status === 'awaiting_permission');

  // Load and keep live while mounted; the parent panel mounts this only for an expanded subagent.
  $effect(() => {
    const sid = sessionId;
    conn.generation;
    if (conn.status !== 'online') return;
    openSession(sid, cwd).catch(() => {});
  });
  $effect(() => {
    const sid = sessionId;
    return () => untrack(() => leaveSession(sid));
  });

  type Steps = { kind: 'steps'; id: string; items: (TextItem | ToolItem)[] };
  let blocks = $derived.by(() => {
    const out: (Exclude<Item, ToolItem> | Steps)[] = [];
    for (const it of view?.items ?? []) {
      if (it.kind === 'thought' || it.kind === 'tool') {
        const last = out[out.length - 1];
        if (last?.kind === 'steps') last.items.push(it);
        else out.push({ kind: 'steps', id: 'g' + it.id, items: [it] });
      } else out.push(it);
    }
    return out;
  });

  let openGroups = $state<Record<string, boolean>>({});
  function summary(g: Steps) {
    const tools = g.items.filter((i) => i.kind === 'tool');
    const active = tools.filter((t) => t.status === 'pending' || t.status === 'in_progress').pop();
    if (active) return active.title;
    if (!tools.length) return 'Thought';
    const failed = tools.filter((t) => t.status === 'failed').length;
    return `${tools.length} step${tools.length > 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`;
  }
  const working = (g: Steps) => g.items.some((i) => i.kind === 'tool' && (i.status === 'pending' || i.status === 'in_progress'));
  const isOpen = (g: Steps, last: boolean) => openGroups[g.id] ?? (last && busy);

  let scroller = $state<HTMLElement>();
  $effect(() => {
    view?.seq;
    tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });
</script>

<div class="transcript scroller" bind:this={scroller}>
  <div class="tcol">
    {#if !view?.ready}
      {#if view?.error}<div class="notice error">{view.error}</div>{:else}<div class="empty"><span class="spinner"></span></div>{/if}
    {:else if blocks.length === 0}
      <div class="empty"><p class="small">No transcript yet.</p></div>
    {:else}
      {#each blocks as b, i (b.id)}
        {#if b.kind === 'user'}
          <div class="msg user"><div class="bubble">{b.text}</div></div>
        {:else if b.kind === 'assistant'}
          <div class="msg assistant"><div class="md">{@html markdown(fileUrlsToPaths(b.text))}</div></div>
        {:else if b.kind === 'steps'}
          {@const last = i === blocks.length - 1}
          {@const opened = isOpen(b, last)}
          <div class="steps">
            <button class="shead" onclick={() => (openGroups[b.id] = !opened)} aria-expanded={opened}>
              {#if working(b) || (last && busy)}<span class="spinner sm"></span>{:else}<Icon name="list" size={15} />{/if}
              <span class="stext">{summary(b)}</span>
              <span class="chev" class:open={opened}><Icon name="chevron" size={14} /></span>
            </button>
            {#if opened}
              <div class="sbody">
                {#each b.items as it (it.id)}
                  {#if it.kind === 'thought'}
                    <details class="thought">
                      <summary><Icon name="brain" size={14} /> Thinking <span class="peek">{it.text.slice(0, 80)}</span></summary>
                      <div class="md ttext">{@html markdown(it.text)}</div>
                    </details>
                  {:else if it.kind === 'tool'}
                    <ToolCall item={it} />
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {:else if b.kind === 'plan'}
          <div class="plan card">
            <div class="phead"><Icon name="list" size={15} /> Plan</div>
            {#each b.entries as e}
              <div class="pitem {e.status}"><span class="box">{#if e.status === 'completed'}<Icon name="check" size={12} />{/if}</span><span>{e.content}</span></div>
            {/each}
          </div>
        {:else if b.kind === 'notice'}
          <div class="notice {b.level}">{b.text}</div>
        {/if}
      {/each}
      {#if busy && blocks[blocks.length - 1]?.kind === 'user'}
        <div class="typing" aria-label="Working"><span></span><span></span><span></span></div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .transcript {
    max-height: 46vh;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .tcol {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 4px 2px 8px;
  }
  .small {
    font-size: 12.5px;
    color: var(--text-3);
  }
  .msg.user {
    display: flex;
    justify-content: flex-end;
  }
  .bubble {
    max-width: 86%;
    padding: 9px 14px;
    border-radius: 18px 18px 6px 18px;
    background: color-mix(in srgb, var(--accent) 13%, var(--bg-elev2));
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.45;
    font-size: 14px;
  }
  .msg.assistant {
    font-size: 14.5px;
    line-height: 1.55;
  }
  .steps {
    margin: -2px 0;
  }
  .shead {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    width: 100%;
    padding: 0 10px;
    border-radius: 999px;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
  }
  .shead:active {
    background: var(--fill);
  }
  .stext {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    display: grid;
    transition: transform 0.2s var(--ease-out);
    color: var(--text-3);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .spinner.sm {
    width: 13px;
    height: 13px;
  }
  .sbody {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 0 2px 12px;
    margin-left: 2px;
    border-left: 2px solid var(--line);
  }
  .thought summary {
    display: flex;
    align-items: center;
    gap: 6px;
    list-style: none;
    cursor: pointer;
    color: var(--text-2);
    font-size: 13px;
    min-height: 30px;
  }
  .thought summary::-webkit-details-marker {
    display: none;
  }
  .peek {
    flex: 1;
    min-width: 0;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thought[open] .peek {
    display: none;
  }
  .ttext {
    color: var(--text-2);
    font-size: 13px;
    padding: 2px 0 6px 20px;
  }
  .plan {
    padding: 10px 12px;
    font-size: 13.5px;
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-2);
    font-size: 12.5px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .pitem {
    display: flex;
    gap: 8px;
    padding: 3px 0;
  }
  .pitem .box {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    border-radius: 50%;
    border: 1.5px solid var(--line-strong);
    display: grid;
    place-items: center;
  }
  .pitem.completed {
    color: var(--text-3);
    text-decoration: line-through;
  }
  .pitem.completed .box {
    background: var(--green);
    border-color: var(--green);
    color: var(--bg);
  }
  .pitem.in_progress .box {
    border-color: var(--green);
    box-shadow: inset 0 0 0 3px var(--bg-elev), inset 0 0 0 8px var(--green);
  }
  .notice {
    font-size: 13px;
    color: var(--text-2);
    padding: 8px 12px;
    border-radius: 12px;
    background: var(--bg-elev);
    border: 1px solid var(--line);
  }
  .notice.error {
    color: var(--red);
    border-color: color-mix(in srgb, var(--red) 35%, transparent);
  }
  .typing {
    display: flex;
    gap: 4px;
    padding: 6px 0 2px 4px;
  }
  .typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-3);
    animation: blink 1.2s infinite ease-in-out;
  }
  .typing span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .typing span:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes blink {
    0%,
    80%,
    100% {
      opacity: 0.25;
    }
    40% {
      opacity: 1;
    }
  }
</style>
