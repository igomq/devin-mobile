<script lang="ts">
  import { go, layout, toggleSidebar } from '#lib/ui.svelte.ts';
  import Icon from './Icon.svelte';

  // Screens that go back to the session list show the sidebar toggle instead on tablets,
  // where the list is already beside them.
  let { to = '#/', label = 'Back' }: { to?: string; label?: string } = $props();
  let toList = $derived(to === '#/' && layout.wide);
</script>

{#if toList}
  <button class="iconbtn glass" onclick={toggleSidebar} aria-label={layout.sidebar ? 'Hide sidebar' : 'Show sidebar'} title="Toggle sidebar">
    <Icon name="sidebar" />
  </button>
{:else}
  <button class="iconbtn glass" onclick={() => go(to)} aria-label={label}><Icon name="back" /></button>
{/if}
