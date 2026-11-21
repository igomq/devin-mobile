<script lang="ts">
  import { lineDiff, basename } from '#lib/format.ts';
  import type { ComponentProps } from 'svelte';
  import type { ToolItem } from '#lib/types.ts';
  import Icon from './Icon.svelte';
  import DiffRows from './DiffRows.svelte';

  let { item, open = false }: { item: ToolItem; open?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  let expanded = $state(open);

  const icons: Record<string, ComponentProps<typeof Icon>['name']> = { read: 'file', edit: 'edit', delete: 'trash', move: 'file', search: 'search', execute: 'terminal', think: 'brain', fetch: 'globe' };
  let command = $derived(item.rawInput?.command ?? item.rawInput?.cmd ?? null);
  let output = $derived.by(() => {
    const texts = (item.content ?? []).flatMap((c) => (c.type === 'text' && c.text ? [c.text] : []));
    if (texts.length) return texts.join('\n');
    const raw = item.rawOutput;
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    return raw.output ?? raw.stdout ?? raw.text ?? JSON.stringify(raw, null, 2);
  });
  let diffs = $derived((item.content ?? []).filter((c) => c.type === 'diff'));
  let inputText = $derived.by(() => {
    if (command || item.rawInput == null) return '';
    const keys = Object.keys(item.rawInput);
    return keys.length ? JSON.stringify(item.rawInput, null, 2) : '';
  });
  let hasBody = $derived(Boolean(command || output || diffs.length || inputText || item.locations?.length));
  const ext = (p: string) => (p?.split('.').pop() ?? '').toLowerCase();
</script>

<div class="tool" class:failed={item.status === 'failed'}>
  <button class="head" onclick={() => (expanded = !expanded)} disabled={!hasBody} aria-expanded={expanded}>
    <span class="ic"><Icon name={icons[item.toolKind] ?? 'play'} size={15} /></span>
    <span class="t">{item.title}</span>
    {#if item.status === 'pending' || item.status === 'in_progress'}
      <span class="spinner sm"></span>
    {:else if item.status === 'failed'}
      <span class="st bad"><Icon name="x" size={14} /></span>
    {:else}
      <span class="st ok"><Icon name="check" size={14} /></span>
    {/if}
    {#if hasBody}<span class="chev" class:open={expanded}><Icon name="chevron" size={14} /></span>{/if}
  </button>
  {#if expanded && hasBody}
    <div class="body">
      {#if command}<pre class="cmd"><span class="ps">$</span> {command}</pre>{/if}
      {#if inputText}<pre class="out">{inputText}</pre>{/if}
      {#each diffs as d}
        <div class="fname mono">{basename(d.path)} <span class="muted">{d.oldText == null ? 'new file' : ''}</span></div>
        <DiffRows rows={lineDiff(d.oldText ?? '', d.newText ?? '')} lang={ext(d.path)} />
      {/each}
      {#if !diffs.length && item.locations?.length}
        {#each item.locations as l}<div class="fname mono">{l.path}{l.line ? ':' + l.line : ''}</div>{/each}
      {/if}
      {#if output}<pre class="out">{output.length > 20000 ? output.slice(0, 20000) + '\n… output truncated' : output}</pre>{/if}
    </div>
  {/if}
</div>

<style>
  .tool {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg-elev);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 38px;
    padding: 6px 10px;
    text-align: left;
    opacity: 1 !important;
  }
  .ic {
    color: var(--text-2);
    display: grid;
    flex: none;
  }
  .t {
    flex: 1;
    min-width: 0;
    font: 12.5px var(--mono);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st {
    display: grid;
    flex: none;
  }
  .st.ok {
    color: var(--green);
  }
  .st.bad {
    color: var(--red);
  }
  .chev {
    color: var(--text-3);
    display: grid;
    transition: transform 0.15s;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .spinner.sm {
    width: 13px;
    height: 13px;
  }
  .body {
    border-top: 1px solid var(--line);
    background: var(--bg);
  }
  pre {
    margin: 0;
    padding: 8px 10px;
    font: 12px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 320px;
    overflow: auto;
  }
  .cmd {
    color: var(--text);
    border-bottom: 1px solid var(--line);
  }
  .ps {
    color: var(--green);
  }
  .out {
    color: var(--text-2);
  }
  .fname {
    font-size: 12px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
    overflow-wrap: anywhere;
  }
</style>
