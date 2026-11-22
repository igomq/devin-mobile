<script lang="ts">
  import Sheet from '../Sheet.svelte';
  import type { ConfirmRequest } from './git.svelte.ts';

  /** Set `request` to ask; it is cleared when the sheet closes. The confirm button runs `request.run`. */
  let { request = $bindable(null) }: { request?: ConfirmRequest | null } = $props();

  let typed = $state('');
  let acked = $state(false);
  let option = $state(false);
  let working = $state(false);

  // Fresh inputs for every new request.
  $effect(() => {
    const r = request;
    typed = '';
    acked = false;
    option = r?.option?.checked ?? false;
  });

  let ready = $derived(
    Boolean(request) && !working && (!request?.typeToConfirm || typed.trim() === request.typeToConfirm) && (!request?.acknowledge || acked)
  );

  async function confirm() {
    const r = request;
    if (!r || !ready) return;
    working = true;
    try {
      await r.run(option);
    } finally {
      working = false;
      if (request === r) request = null;
    }
  }
</script>

<Sheet
  bind:open={() => request !== null, (v) => {
    if (!v && !working) request = null;
  }}
  title={request?.title ?? ''}
>
  {#if request}
    <form class="confirm" onsubmit={(e) => (e.preventDefault(), confirm())}>
      <p class="msg">{request.message}</p>
      {#if request.acknowledge}
        <label class="g-check warn">
          <input type="checkbox" bind:checked={acked} />
          <span>{request.acknowledge}</span>
        </label>
      {/if}
      {#if request.option}
        <label class="g-switch">
          <span>{request.option.label}</span>
          <input type="checkbox" role="switch" bind:checked={option} />
        </label>
      {/if}
      {#if request.typeToConfirm}
        <label class="field">
          <span>Type <b class="mono">{request.typeToConfirm}</b> to confirm</span>
          <input class="mono" bind:value={typed} autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" />
        </label>
      {/if}
      <div class="row">
        <button type="button" class="btn" onclick={() => (request = null)} disabled={working}>Cancel</button>
        <button type="submit" class="btn" class:danger={request.danger !== false} class:primary={request.danger === false} disabled={!ready}>
          {#if working}<span class="spinner"></span>{/if}
          {request.confirmLabel}
        </button>
      </div>
    </form>
  {/if}
</Sheet>

<style>
  .confirm {
    padding-top: 2px;
  }
  .msg {
    margin: 0 4px 16px;
    font-size: 15px;
    color: var(--text-2);
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  .field b {
    color: var(--text);
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 10px;
    margin-top: 6px;
  }
  .row .btn {
    flex: 1;
    background: var(--fill);
  }
  .row .btn.primary {
    background: var(--accent);
  }
  .row .btn.danger:not(:disabled) {
    background: color-mix(in srgb, var(--red) 14%, transparent);
  }
</style>
