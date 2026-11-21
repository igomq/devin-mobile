<script lang="ts">
  import type { ConfigOption } from '#lib/types.ts';
  import { splitModels } from '#lib/models.ts';
  import Icon from './Icon.svelte';

  let { option, disabled = false, onpick }: { option: ConfigOption; disabled?: boolean; onpick: (value: string) => void } = $props();
  let m = $derived(splitModels(option));
  let current = $derived(m.pairs.find((p) => p.value === option.currentValue));
  // svelte-ignore state_referenced_locally
  let tab = $state<'single' | 'fusion'>(current ? 'fusion' : 'single');
  let main = $state('');
  let side = $state('');
  $effect(() => {
    if (current) {
      main = current.main;
      side = current.side;
    } else if (!main && m.mains.length) {
      main = m.mains[0];
      side = m.sidesFor(main)[0] ?? '';
    }
  });
  let sides = $derived(m.sidesFor(main));

  function pickMain(v: string) {
    main = v;
    if (!sides.includes(side)) side = m.sidesFor(v)[0] ?? '';
  }
  let chosen = $derived(m.find(main, side));
</script>

{#if m.pairs.length}
  <div class="tabs">
    <button class:on={tab === 'single'} onclick={() => (tab = 'single')}>Single model</button>
    <button class:on={tab === 'fusion'} onclick={() => (tab = 'fusion')}>Fusion</button>
  </div>
{/if}

{#if tab === 'single' || !m.pairs.length}
  <div class="selwrap">
    <select value={current ? '' : option.currentValue} {disabled} onchange={(e) => e.currentTarget.value && onpick(e.currentTarget.value)}>
      {#if current}<option value="" disabled>Choose a model</option>{/if}
      {#each m.singles as x}<option value={x.value}>{x.name}</option>{/each}
    </select>
    <Icon name="down" size={16} />
  </div>
{:else}
  <div class="fusion">
    <span class="sub">Main model</span>
    <div class="selwrap">
      <select value={main} {disabled} onchange={(e) => pickMain(e.currentTarget.value)}>
        {#each m.mains as x}<option value={x}>{x}</option>{/each}
      </select>
      <Icon name="down" size={16} />
    </div>
    <span class="sub">Sidekick</span>
    <div class="selwrap">
      <select value={side} {disabled} onchange={(e) => (side = e.currentTarget.value)}>
        {#each sides as x}<option value={x}>{x}</option>{/each}
      </select>
      <Icon name="down" size={16} />
    </div>
    <button class="btn block primary" disabled={disabled || !chosen || chosen.value === option.currentValue} onclick={() => chosen && onpick(chosen.value)}>
      {chosen && chosen.value === option.currentValue ? 'In use' : 'Use this pair'}
    </button>
  </div>
{/if}

<style>
  .tabs {
    display: flex;
    gap: 4px;
    padding: 4px;
    margin-bottom: 8px;
    border-radius: 12px;
    background: var(--bg);
    border: 1px solid var(--line);
  }
  .tabs button {
    flex: 1;
    min-height: 34px;
    border-radius: 9px;
    font-size: 14px;
    color: var(--text-2);
    transition: background 0.18s, color 0.18s;
  }
  .tabs button.on {
    background: var(--bg-elev2);
    color: var(--text);
    font-weight: 600;
  }
  .fusion {
    display: grid;
    gap: 6px;
  }
  .sub {
    font-size: 12.5px;
    color: var(--text-2);
    margin: 2px 2px 0;
  }
  .fusion .btn {
    margin-top: 6px;
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
</style>
