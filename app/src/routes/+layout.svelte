<script lang="ts">
  import '../fonts.css';
  import '../app.css';
  import { onMount } from 'svelte';
  import { applyTheme, toasts } from '#lib/ui.svelte.ts';
  import { connect, configured } from '#lib/api.svelte.ts';

  let { children } = $props();

  onMount(() => {
    applyTheme();
    if (configured()) connect();
    // Keep the layout above the on-screen keyboard (iOS does not resize the layout viewport).
    const vv = window.visualViewport;
    const fitViewport = () => {
      document.documentElement.style.setProperty('--vvh', (vv ? vv.height : window.innerHeight) + 'px');
      window.scrollTo(0, 0);
    };
    fitViewport();
    vv?.addEventListener('resize', fitViewport);
    vv?.addEventListener('scroll', fitViewport);
    window.addEventListener('resize', fitViewport);
    return () => {
      vv?.removeEventListener('resize', fitViewport);
      vv?.removeEventListener('scroll', fitViewport);
      window.removeEventListener('resize', fitViewport);
    };
  });
</script>

{@render children()}

<div class="toasts" aria-live="polite">
  {#each toasts as t (t.id)}<div class="toast {t.kind}">{t.text}</div>{/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 0;
    right: 0;
    top: calc(var(--safe-top) + 58px);
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    pointer-events: none;
    padding: 0 16px;
  }
  .toast {
    max-width: 420px;
    padding: 9px 14px;
    border-radius: 12px;
    background: var(--bg-elev2);
    border: 1px solid var(--line-strong);
    font-size: 14px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
  }
  .toast.error {
    color: var(--red);
  }
</style>
