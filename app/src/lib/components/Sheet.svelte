<script lang="ts">
  import type { Snippet } from 'svelte';
  let { open = $bindable(false), title = '', children, tall = false }: { open?: boolean; title?: string; children: Snippet; tall?: boolean } = $props();
  const close = () => (open = false);
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && close()} />

{#if open}
  <div class="scrim" onclick={close} role="presentation"></div>
  <div class="sheet" class:tall role="dialog" aria-modal="true" aria-label={title}>
    <div class="grab"></div>
    {#if title}
      <header>
        <b>{title}</b>
        <button class="done" onclick={close}>Done</button>
      </header>
    {/if}
    <div class="body">{@render children?.()}</div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 40;
    animation: fade 0.15s ease-out;
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 41;
    max-width: 820px;
    margin: 0 auto;
    max-height: min(82%, calc(var(--vvh) - 40px));
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border-radius: 20px 20px 0 0;
    border: 1px solid var(--line);
    border-bottom: 0;
    animation: rise 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .sheet.tall {
    height: min(92%, calc(var(--vvh) - 20px));
    max-height: none;
  }
  .grab {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--line-strong);
    margin: 8px auto 2px;
    flex: none;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 16px 10px;
    flex: none;
  }
  header b {
    font-size: 16px;
  }
  .done {
    color: var(--blue);
    font-weight: 600;
    padding: 6px 4px;
  }
  .body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 0 16px calc(var(--safe-bottom) + 18px);
    flex: 1;
    min-height: 0;
  }
  @keyframes rise {
    from {
      transform: translateY(24px);
      opacity: 0;
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
