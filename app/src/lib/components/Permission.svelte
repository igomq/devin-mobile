<script lang="ts">
  import { rpc, errorText } from '#lib/api.svelte.ts';
  import type { PermissionView } from '#lib/types.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import { lineDiff, basename } from '#lib/format.ts';
  import Icon from './Icon.svelte';
  import DiffRows from './DiffRows.svelte';

  let { sessionId, request }: { sessionId: string; request: PermissionView } = $props();
  let busy = $state(false);
  let command = $derived(request.rawInput?.command ?? request.rawInput?.cmd ?? null);
  let diffs = $derived((request.content ?? []).filter((c) => c.type === 'diff'));
  let text = $derived((request.content ?? []).flatMap((c) => (c.type === 'text' && c.text && c.text !== command ? [c.text] : [])).join('\n'));
  const order: Record<string, number> = { allow_once: 0, allow_always: 1, reject_once: 2, reject_always: 3 };
  let options = $derived([...request.options].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9)));

  async function answer(optionId: string) {
    busy = true;
    try {
      await rpc('session.permission', { id: sessionId, reqId: request.reqId, optionId });
    } catch (e) {
      toast(errorText(e), 'error');
      busy = false;
    }
  }
</script>

<div class="perm" role="alertdialog" aria-label="Permission request">
  <div class="head"><Icon name="shield" size={16} /> <b>Devin needs approval</b></div>
  <div class="details">
    <div class="what mono">{request.title}</div>
    {#if command && command !== request.title}<pre class="cmd"><span class="ps">$</span> {command}</pre>{/if}
    {#if text}<pre class="cmd">{text}</pre>{/if}
    {#each diffs as d}
      <div class="prev">
        <div class="fname mono">{basename(d.path)}</div>
        <DiffRows rows={lineDiff(d.oldText ?? '', d.newText ?? '')} />
      </div>
    {/each}
  </div>
  <div class="opts">
    {#each options as o}
      <button class="btn" class:primary={o.kind === 'allow_once'} class:danger={o.kind?.startsWith('reject')} disabled={busy} onclick={() => answer(o.optionId)}>{o.name}</button>
    {/each}
  </div>
</div>

<style>
  .perm {
    flex: none;
    margin: 0 12px 8px;
    padding: 12px;
    border: 1px solid var(--amber);
    border-radius: var(--radius);
    background: var(--bg-elev);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--amber);
    font-size: 13px;
    margin-bottom: 6px;
  }
  .details {
    max-height: 38vh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .what {
    font-size: 13px;
    overflow-wrap: anywhere;
    margin-bottom: 8px;
  }
  .cmd {
    margin: 0 0 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--bg);
    font: 12px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 120px;
    overflow: auto;
  }
  .ps {
    color: var(--green);
  }
  .prev {
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 8px;
    max-height: 180px;
    overflow-y: auto;
    background: var(--bg);
  }
  .fname {
    font-size: 12px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--line);
  }
  .opts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .opts .btn {
    flex: 1 1 auto;
    min-height: 42px;
    font-size: 14px;
    padding: 0 12px;
  }
</style>
