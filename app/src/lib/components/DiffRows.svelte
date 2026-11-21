<script lang="ts">
  import { highlight } from '#lib/format.ts';
  import type { DiffRow } from '#lib/types.ts';
  let { rows, lang = '' }: { rows: DiffRow[]; lang?: string } = $props();
  const MAX = 1500;
  let showAll = $state(false);
  let visible = $derived(showAll ? rows : rows.slice(0, MAX));
</script>

<div class="diff">
  <div class="diff-inner">
    {#each visible as r}
      {#if r.type === 'hunk' || r.type === 'meta'}
        <div class="drow {r.type}">{r.text}</div>
      {:else}
        <div class="drow {r.type}"><span class="ln">{r.type === 'add' ? (r.b ?? '') : (r.a ?? '')}</span><span class="tx">{@html highlight(r.text, lang)}</span></div>
      {/if}
    {/each}
  </div>
</div>
{#if rows.length > MAX && !showAll}
  <button class="more" onclick={() => (showAll = true)}>Show all {rows.length} lines</button>
{/if}

<style>
  .more {
    display: block;
    width: 100%;
    padding: 10px;
    font-size: 13px;
    color: var(--blue);
  }
</style>
