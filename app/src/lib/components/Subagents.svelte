<script lang="ts">
  import { untrack } from 'svelte';
  import { app, conn, errorText, rpc } from '#lib/api.svelte.ts';
  import { toast } from '#lib/ui.svelte.ts';
  import { flatValues, isModelOption } from '#lib/models.ts';
  import type { ConfigOption, ConfigOptionValue, SubagentDefault } from '#lib/types.ts';
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

  let errorLine = $derived(/unknown request/i.test(loadError ?? '') ? 'Update the gateway on the VM to set subagent settings.' : loadError);
  let harnesses = $derived(app.harnesses.filter((h) => h.enabled && (h.installed || h.id === 'devin')));
  const of = (id: string) => defaults.find((d) => d.harnessId === id);
  const isModeOption = (o: ConfigOption) => o.id === 'mode' || o.category === 'mode';

  function modeChoices(d: SubagentDefault | undefined): { value: string; name: string }[] {
    const out = new Map<string, string>();
    for (const m of d?.modes ?? []) if (m?.id) out.set(m.id, m.name || m.id);
    const modeOpt = (d?.options ?? []).find(isModeOption);
    for (const v of modeOpt ? flatValues(modeOpt) : []) out.set(v.value, v.name || v.value);
    return [...out.entries()].map(([value, name]) => ({ value, name }));
  }
  function configOptions(d: SubagentDefault | undefined): ConfigOption[] {
    return (d?.options ?? []).filter((o) => !isModelOption(o) && !isModeOption(o));
  }
  function currentConfig(d: SubagentDefault | undefined, o: ConfigOption) {
    return d?.policy.config?.[o.id] ?? o.currentValue;
  }

  async function save(harnessId: string, model: string) {
    try {
      defaults = await rpc('subagents.setDefault', { harnessId, model: model.trim() || null });
      toast(model.trim() ? `Subagents on ${harnessId} use ${model.trim()}` : `Subagents on ${harnessId} use its default model`, 'info');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  async function savePolicy(harnessId: string, patch: { mode?: string | null; config?: Record<string, string | boolean>; enabled?: boolean }) {
    try {
      defaults = await rpc('subagents.setPolicy', { harnessId, ...patch });
      toast('Subagent delegation settings saved', 'info');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }
  function saveMode(harnessId: string, value: string) {
    savePolicy(harnessId, { mode: value || null });
  }
  function saveEnabled(harnessId: string, enabled: boolean) {
    savePolicy(harnessId, { enabled });
  }
  function saveConfig(harnessId: string, o: ConfigOption, value: string | boolean | null) {
    const d = of(harnessId);
    const config = { ...(d?.policy.config ?? {}) };
    if (value === null || value === '') delete config[o.id];
    else config[o.id] = value;
    savePolicy(harnessId, { config });
  }
  function optionValues(o: ConfigOption): ConfigOptionValue[] {
    return flatValues(o);
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
        Model, permission mode and effort settings each harness uses when uniharn delegates work to it. Delegated sessions are kept non-interactive where the
        harness allows it; harnesses that only offer per-action approval are disabled here.
      </p>
      {#if loadError}<p class="muted detail bad">{errorLine}</p>{/if}

      {#each harnesses as h (h.id)}
        {@const d = of(h.id)}
        {@const modes = modeChoices(d)}
        {@const opts = configOptions(d)}
        <div class="label">{h.name}</div>
        <div class="card">
          <label class="kv check">
            <span>Allow delegation</span>
            <input type="checkbox" checked={d?.policy.enabled !== false} onchange={(e) => saveEnabled(h.id, e.currentTarget.checked)} aria-label="Allow delegation to {h.name}" />
          </label>
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
          {#if modes.length}
            <label class="kv">
              <span>Mode</span>
              <select value={d?.policy.mode ?? ''} onchange={(e) => saveMode(h.id, e.currentTarget.value)} aria-label="Delegation mode for {h.name}">
                <option value="">Harness choice</option>
                {#each modes as m (m.value)}<option value={m.value}>{m.name}</option>{/each}
                {#if d?.policy.mode && !modes.some((m) => m.value === d.policy.mode)}<option value={d.policy.mode}>{d.policy.mode}</option>{/if}
              </select>
            </label>
          {/if}
          {#each opts as o (o.id)}
            {@const values = optionValues(o)}
            <label class="kv">
              <span>{o.name || o.id}</span>
              {#if values.length}
                <select value={String(currentConfig(d, o) ?? '')} onchange={(e) => saveConfig(h.id, o, e.currentTarget.value || null)} aria-label="{o.name || o.id} for {h.name}">
                  <option value="">Harness default</option>
                  {#each values as v (v.value)}<option value={v.value}>{v.name || v.value}</option>{/each}
                  {#if currentConfig(d, o) !== undefined && currentConfig(d, o) !== null && !values.some((v) => String(v.value) === String(currentConfig(d, o)))}<option value={String(currentConfig(d, o))}>{String(currentConfig(d, o))}</option>{/if}
                </select>
              {:else if o.type === 'boolean' || typeof o.currentValue === 'boolean'}
                <input type="checkbox" checked={!!currentConfig(d, o)} onchange={(e) => saveConfig(h.id, o, e.currentTarget.checked)} aria-label="{o.name || o.id} for {h.name}" />
              {:else}
                <input value={String(currentConfig(d, o) ?? '')} placeholder="Harness default" onchange={(e) => saveConfig(h.id, o, e.currentTarget.value || null)} aria-label="{o.name || o.id} for {h.name}" />
              {/if}
            </label>
          {/each}
          {#if !d?.models.length && !modes.length && !opts.length}<p class="muted detail">Open a chat on {h.name} once to list its models and options here.</p>{/if}
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
  .kv.check input {
    width: 22px;
    height: 22px;
  }
  .kv > span {
    color: var(--text-2);
    flex: none;
  }
  .kv select,
  .kv input:not([type='checkbox']) {
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
