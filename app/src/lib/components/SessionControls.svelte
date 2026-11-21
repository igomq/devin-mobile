<script lang="ts">
  import { rpc, conn, errorText } from '#lib/api.svelte.ts';
  import type { ConfigOption, ConfigOptionValue, Json, SessionView } from '#lib/types.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import { shortPath } from '#lib/format.ts';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';

  let { open = $bindable(false), sessionId, view }: { open?: boolean; sessionId: string; view: SessionView | undefined } = $props();
  let busy = $state<string | null>(null);

  let modes = $derived(view?.state.modes ?? []);
  // Every option the agent exposes (model, reasoning level, …). Mode is left out when it has its own picker above.
  let options = $derived((view?.state.configOptions ?? []).filter((o) => !modes.length || (o.category !== 'mode' && o.id !== 'mode')));
  const flat = (o: ConfigOption): ConfigOptionValue[] => (o.options ?? []).flatMap((x) => ('options' in x ? x.options : [x]));

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
    {#if flat(o).length}
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

  <div class="label">Project</div>
  <p class="mono path">{shortPath(view?.cwd, conn.info?.home)}</p>
  <p class="mono path muted">{sessionId}</p>

  <div class="actions">
    <button class="btn block" onclick={() => ((open = false), go('#/s/' + encodeURIComponent(sessionId) + '/terminal'))}><Icon name="terminal" size={18} /> Open terminal here</button>
    <button class="btn block" disabled={busy !== null} onclick={() => run('close', 'session.close', {}, () => ((open = false), go('#/')))}>End session</button>
    <button class="btn block danger" disabled={busy !== null} onclick={() => run('delete', 'session.delete', {}, () => ((open = false), go('#/')))}>Delete session</button>
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
  .actions {
    display: grid;
    gap: 10px;
    margin-top: 18px;
  }
</style>
