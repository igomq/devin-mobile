<script lang="ts">
  import { conn, configured } from '#lib/api.svelte.ts';
  import { route, layout, sidebarShown, requests } from '#lib/ui.svelte.ts';
  import Connect from '#lib/components/Connect.svelte';
  import Home from '#lib/components/Home.svelte';
  import Chat from '#lib/components/Chat.svelte';
  import Changes from '#lib/components/Changes.svelte';
  import Terminal from '#lib/components/Terminal.svelte';
  import Settings from '#lib/components/Settings.svelte';
  import Icon from '#lib/components/Icon.svelte';

  // Stay in the app while reconnecting; only fall back to pairing when there is nothing to connect to.
  let paired = $derived(configured() && conn.status !== 'unauthorized' && (conn.info !== null || conn.status !== 'offline'));
  let split = $derived(sidebarShown());
</script>

{#if !paired || (conn.info === null && conn.error)}
  <div class="shell"><Connect /></div>
{:else}
  <div class="shell" class:split>
    {#if split}
      <aside class="side"><Home embedded /></aside>
    {/if}
    <div class="pane">
      {#if route.name === 'session' && route.id && route.tab === 'changes'}
        <Changes id={route.id} />
      {:else if route.name === 'session' && route.id && route.tab === 'terminal'}
        {#key route.id}<Terminal sessionId={route.id} />{/key}
      {:else if route.name === 'session' && route.id}
        {#key route.id}<Chat id={route.id} />{/key}
      {:else if route.name === 'terminal'}
        {#key route.login}<Terminal login={route.login} />{/key}
      {:else if route.name === 'settings'}
        <Settings />
      {:else if split}
        <div class="screen placeholder">
          <div class="empty">
            <h2>Pick up where Devin left off</h2>
            <p>Open a session from the list, or start a new one in a project folder.</p>
            <button class="btn primary" onclick={() => (requests.newSession = Date.now())} disabled={conn.status !== 'online'}><Icon name="plus" size={18} /> New session</button>
          </div>
        </div>
      {:else}
        <Home />
      {/if}
    </div>
  </div>
{/if}

<style>
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
  }
  .side {
    flex: none;
    display: flex;
    width: clamp(290px, 32vw, 360px);
    margin: calc(var(--safe-top) + 10px) 0 calc(var(--safe-bottom) + 10px) calc(var(--safe-left) + 10px);
    border-radius: var(--r-xl);
    overflow: hidden;
    /* A resting surface with a glass rim. No backdrop-filter here: it would make the sidebar the containing
       block for the fixed-position sheets opened from it and clip them. */
    background: color-mix(in srgb, var(--bg-elev) 72%, transparent);
    box-shadow: inset 0 1px 0 var(--glass-hi), inset 0 0 0 1px var(--glass-rim), var(--glass-shadow);
    animation: side-in 0.32s var(--ease-out);
  }
  /* Inside the floating sidebar the safe area is already cleared by its margin. */
  .side :global(.screen) {
    --safe-top: 0px;
    --safe-bottom: 0px;
    --safe-left: 0px;
    --bar-h: 64px;
    background: transparent;
    animation: none;
  }
  .side :global(.topbar::before) {
    background: linear-gradient(to bottom, color-mix(in srgb, var(--bg-elev) 96%, transparent) 0%, color-mix(in srgb, var(--bg-elev) 70%, transparent) 55%, transparent 100%);
  }
  .split .pane :global(.screen) {
    --safe-left: 0px;
  }
  .placeholder .empty p {
    margin: 0 0 20px;
  }
  @keyframes side-in {
    from {
      opacity: 0;
      transform: translateX(-12px);
    }
  }
</style>
