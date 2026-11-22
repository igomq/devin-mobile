<script lang="ts">
  import { rpc, conn, errorText } from '#lib/api.svelte.ts';
  import type { ConfigOption, ConfigOptionValue, Json, SessionView } from '#lib/types.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import { shortPath } from '#lib/format.ts';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import { isModelOption } from '#lib/models.ts';
  import { compact, USAGE_URL } from '#lib/usage.ts';

  let { open = $bindable(false), sessionId, view }: { open?: boolean; sessionId: string; view: SessionView | undefined } = $props();
  let busy = $state<string | null>(null);
  let confirmDelete = $state(false);
  $effect(() => {
    if (!open) confirmDelete = false;
  });

  let modes = $derived(view?.state.modes ?? []);
  // Every option the agent exposes (model, reasoning level, …). Mode is left out when it has its own picker above.
  let options = $derived((view?.state.configOptions ?? []).filter((o) => !modes.length || (o.category !== 'mode' && o.id !== 'mode')));
  const flat = (o: ConfigOption): ConfigOptionValue[] => (o.options ?? []).flatMap((x) => ('options' in x ? x.options : [x]));

  let ctx = $derived(view?.state.context ?? null);
  let ctxPct = $derived(ctx ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : 0);
  let tokens = $derived(view?.state.tokens ?? null);
  let stats = $derived(view?.state.turnStats ?? []);

  async function run(key: string, m: string, p: Json, done?: () => void) {
    busy = key;
    try {
      await rpc(m, { id: sessionId, ...p });
      done?.();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      busy = null;
    }
  }
</script>

<Sheet bind:open title="Session">
  {#if modes.length}
  <div class="label">Mode</div>
  <div class="seg">
    {#each modes as m}
      <button class="opt" class:on={view?.state.mode === m.id} disabled={busy !== null} onclick={() => run('mode', 'session.setMode', { modeId: m.id })}>
        <b>{m.name}</b>
        {#if m.description}<small>{m.description}</small>{/if}
        {#if view?.state.mode === m.id}<span class="tick"><Icon name="check" size={16} /></span>{/if}
      </button>
    {/each}
  </div>
  {/if}

  {#each options as o}
    <div class="label">{o.name}</div>
    {#if isModelOption(o) && flat(o).length}
      <ModelPicker option={o} disabled={busy !== null} onpick={(value) => run(o.id, 'session.setConfig', { configId: o.id, value })} />
    {:else if flat(o).length}
      <div class="selwrap">
        <select value={o.currentValue} disabled={busy !== null} onchange={(e) => run(o.id, 'session.setConfig', { configId: o.id, value: e.currentTarget.value })}>
          {#each flat(o) as x}<option value={x.value}>{x.name}</option>{/each}
        </select>
        <Icon name="down" size={16} />
      </div>
    {:else}
      <p class="muted note">Current: <span class="mono">{o.currentValue ?? 'default'}</span>. The CLI lists choices here once it is logged in; you can also type <span class="mono">/model</span> in the chat.</p>
    {/if}
  {/each}

  <div class="label">Usage</div>
  <div class="usage">
    {#if ctx}
      <div class="ctx">
        <span>Context</span><b>{compact(ctx.used)} / {compact(ctx.size)} · {ctxPct}%</b>
      </div>
      <div class="bar" class:warn={ctxPct >= 80}><i style="width: {ctxPct}%"></i></div>
    {/if}
    {#if stats.length}
      {#each stats as s (s.id)}
        <div class="ctx"><span>{s.label}</span><b>{typeof s.value === 'number' ? compact(s.value) : s.value}</b></div>
      {/each}
    {:else if tokens && tokens.turns}
      <div class="ctx"><span>Turns</span><b>{tokens.turns}</b></div>
      <div class="ctx"><span>Input tokens</span><b>{compact(tokens.inputTokens)}</b></div>
      <div class="ctx"><span>Output tokens</span><b>{compact(tokens.outputTokens)}</b></div>
      <div class="ctx"><span>Cached reads</span><b>{compact(tokens.cachedReadTokens)}</b></div>
    {:else if !ctx}
      <p class="muted note">Shown after the first reply in this session.</p>
    {/if}
    <a class="more" href={USAGE_URL} target="_blank" rel="noreferrer">Plan quota and credits <Icon name="chevron" size={14} /></a>
  </div>

  <div class="label">Project</div>
  <p class="mono path">{shortPath(view?.cwd, conn.info?.home)}</p>
  <p class="mono path muted">{sessionId}</p>

  <div class="actions">
    <button class="btn block" onclick={() => ((open = false), go('#/s/' + encodeURIComponent(sessionId) + '/terminal'))}><Icon name="terminal" size={18} /> Open terminal here</button>
    <button class="btn block" disabled={busy !== null} onclick={() => run('close', 'session.close', {}, () => ((open = false), go('#/')))}>End session</button>
    {#if confirmDelete}
      <button class="btn block danger" disabled={busy !== null} onclick={() => run('delete', 'session.delete', {}, () => ((open = false), go('#/')))}>Delete permanently</button>
      <button class="btn block" disabled={busy !== null} onclick={() => (confirmDelete = false)}>Keep session</button>
    {:else}
      <button class="btn block danger" disabled={busy !== null} onclick={() => (confirmDelete = true)}>Delete session</button>
    {/if}
  </div>
</Sheet>

<style>
  .label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    margin: 14px 2px 6px;
  }
  .label:first-child {
    margin-top: 2px;
  }
  .seg {
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg);
  }
  .opt {
    display: block;
    position: relative;
    width: 100%;
    text-align: left;
    padding: 10px 40px 10px 14px;
    border-bottom: 1px solid var(--line);
  }
  .opt:last-child {
    border-bottom: 0;
  }
  .opt b {
    font-weight: 500;
    font-size: 15px;
  }
  .opt small {
    display: block;
    color: var(--text-2);
    font-size: 12.5px;
    line-height: 1.35;
  }
  .opt.on b {
    font-weight: 650;
  }
  .tick {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
  }
  .selwrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .selwrap select {
    appearance: none;
    width: 100%;
    min-height: 46px;
    padding: 0 38px 0 14px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: var(--bg);
  }
  .selwrap :global(svg) {
    position: absolute;
    right: 12px;
    pointer-events: none;
    color: var(--text-2);
  }
  .note {
    font-size: 13.5px;
    margin: 0;
  }
  .path {
    font-size: 12.5px;
    margin: 0 2px 2px;
    overflow-wrap: anywhere;
  }
  .usage {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg);
    padding: 10px 14px;
    display: grid;
    gap: 7px;
  }
  .ctx {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 13.5px;
  }
  .ctx span {
    color: var(--text-2);
  }
  .ctx b {
    font-weight: 550;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    height: 6px;
    border-radius: 99px;
    background: var(--line);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: inherit;
    transition: width 0.4s ease;
  }
  .bar.warn i {
    background: var(--amber);
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    color: var(--accent);
    text-decoration: none;
  }
  .actions {
    display: grid;
    gap: 10px;
    margin-top: 18px;
  }
</style>
