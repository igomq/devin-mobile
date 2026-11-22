<script lang="ts">
  import '../fonts.css';
  import '../app.css';
  import { onMount } from 'svelte';
  import { applyTheme, toasts, go, layout, toggleSidebar, requests } from '#lib/ui.svelte.ts';
  import { connect, configured } from '#lib/api.svelte.ts';

  let { children } = $props();

  // Hardware-keyboard shortcuts (iPad Magic Keyboard, desktop browsers).
  function shortcuts(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === 'n') {
      if (!layout.wide || !layout.sidebar) go('#/');
      requests.newSession = Date.now();
    } else if (key === 'k') {
      if (!layout.wide) go('#/');
      else if (!layout.sidebar) toggleSidebar();
      requests.search = Date.now();
    } else if (key === ',') go('#/settings');
    else if (key === '\\') toggleSidebar();
    else return;
    e.preventDefault();
  }

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

<svelte:window onkeydown={shortcuts} />

{@render children()}

<div class="toasts" aria-live="polite">
  {#each toasts as t (t.id)}<div class="toast glass {t.kind}">{t.text}</div>{/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 0;
    right: 0;
    top: calc(var(--safe-top) + 66px);
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
    padding: 0 16px;
  }
  .toast {
    max-width: 440px;
    padding: 11px 18px;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 500;
    text-align: center;
    animation: toast-in 0.34s var(--ease-spring);
  }
  .toast.error {
    color: var(--red);
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(-10px) scale(0.94);
    }
  }
</style>
