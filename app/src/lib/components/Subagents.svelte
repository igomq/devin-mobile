<script lang="ts">
  import { untrack } from 'svelte';
  import { app, conn, errorText, rpc } from '#lib/api.svelte.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import type { SubagentDefault } from '#lib/types.ts';
  import BackButton from './BackButton.svelte';

  let defaults = $state<SubagentDefault[]>([]);
  let loadError = $state<string | null>(null);

  async function load() {
    try {
      defaults = await rpc('subagents.get');
      loadError = null;
    } catch (e) {
      loadError = errorText(e);
    }
  }
  $effect(() => {
    if (conn.status === 'online' && conn.generation) untrack(() => load());
  });

  let errorLine = $derived(/unknown request/i.test(loadError ?? '') ? 'Update the gateway on the VM to set subagent models.' : loadError);
  let harnesses = $derived(app.harnesses.filter((h) => h.enabled && (h.installed || h.id === 'devin')));
  const of = (id: string) => defaults.find((d) => d.harnessId === id);

  async function save(harnessId: string, model: string) {
    try {
      defaults = await rpc('subagents.setDefault', { harnessId, model: model.trim() || null });
      toast(model.trim() ? `Subagents on ${harnessId} use ${model.trim()}` : `Subagents on ${harnessId} use its default model`, 'info');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to="#/settings" />
    <div class="title"><b>Subagents</b></div>
  </header>
  <main class="scroller">
    <div class="column">
      <p class="muted intro">
        The model each harness uses when it runs as a subagent. Chat sessions keep their own model. An agent in any session can also hand work to these
        harnesses itself through uniharn: ask it, for example, “have Codex review this change”.
      </p>
      {#if loadError}<p class="muted detail bad">{errorLine}</p>{/if}

      {#each harnesses as h (h.id)}
        {@const d = of(h.id)}
        <div class="label">{h.name}</div>
        <div class="card">
          <label class="kv">
            <span>Model</span>
            {#if d?.models.length}
              <select value={d.model ?? ''} onchange={(e) => save(h.id, e.currentTarget.value)} aria-label="Subagent model for {h.name}">
                <option value="">Harness default</option>
                {#each d.models as m (m.value)}<option value={m.value}>{m.name}</option>{/each}
                {#if d.model && !d.models.some((m) => m.value === d.model)}<option value={d.model}>{d.model}</option>{/if}
              </select>
            {:else}
              <input value={d?.model ?? ''} placeholder="Harness default" onchange={(e) => save(h.id, e.currentTarget.value)} aria-label="Subagent model for {h.name}" />
            {/if}
          </label>
          {#if !d?.models.length}<p class="muted detail">Open a chat on {h.name} once to list its models here, or type a model id.</p>{/if}
        </div>
      {/each}
    </div>
  </main>
</div>

<style>
  .column {
    max-width: 640px;
    margin-inline: auto;
    padding: 0 calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .intro {
    font-size: 13px;
    margin: 4px 0 0;
  }
  .card {
    padding: 0 16px;
  }
  .kv {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 48px;
    padding: 8px 0;
    font-size: 15px;
  }
  .kv > span {
    color: var(--text-2);
    flex: none;
  }
  .kv select,
  .kv input {
    min-width: 0;
    max-width: 60%;
  }
  .detail {
    font-size: 13px;
    margin: 0 0 12px;
  }
  .bad {
    color: var(--amber);
  }
</style>
