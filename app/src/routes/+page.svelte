<script lang="ts">
  import { conn, configured } from '#lib/api.svelte.ts';
  import { route } from '#lib/ui.svelte.ts';
  import Connect from '#lib/components/Connect.svelte';
  import Home from '#lib/components/Home.svelte';
  import Chat from '#lib/components/Chat.svelte';
  import Changes from '#lib/components/Changes.svelte';
  import Terminal from '#lib/components/Terminal.svelte';
  import Settings from '#lib/components/Settings.svelte';

  // Stay in the app while reconnecting; only fall back to pairing when there is nothing to connect to.
  let paired = $derived(configured() && conn.status !== 'unauthorized' && (conn.info !== null || conn.status !== 'offline'));
</script>

{#if !paired || (conn.info === null && conn.error)}
  <Connect />
{:else if route.name === 'session' && route.id && route.tab === 'changes'}
  <Changes id={route.id} />
{:else if route.name === 'session' && route.id && route.tab === 'terminal'}
  {#key route.id}<Terminal sessionId={route.id} />{/key}
{:else if route.name === 'session' && route.id}
  {#key route.id}<Chat id={route.id} />{/key}
{:else if route.name === 'terminal'}
  <Terminal login={route.login} />
{:else if route.name === 'settings'}
  <Settings />
{:else}
  <Home />
{/if}
