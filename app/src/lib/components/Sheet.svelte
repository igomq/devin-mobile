<script lang="ts">
  import type { Snippet } from 'svelte';
  import { layout } from '#lib/ui.svelte.ts';
  let { open = $bindable(false), title = '', children, tall = false }: { open?: boolean; title?: string; children: Snippet; tall?: boolean } = $props();
  const close = () => (open = false);

  // Drag the handle or header down to dismiss (phones). The sheet follows the finger 1:1; on release the
  // projected resting point decides between closing and springing back.
  let sheet = $state<HTMLElement>();
  let drag = $state(0);
  let dragging = $state(false);
  let startY = 0;
  let samples: { y: number; t: number }[] = [];

  function down(e: PointerEvent) {
    if (layout.wide || e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    samples = [{ y: e.clientY, t: e.timeStamp }];
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    const dy = e.clientY - startY;
    // Rubber-band upward: the sheet resists instead of stopping hard.
    drag = dy >= 0 ? dy : -((-dy * 60) / (60 + -dy));
    samples.push({ y: e.clientY, t: e.timeStamp });
    if (samples.length > 5) samples.shift();
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const velocity = last.t > first.t ? ((last.y - first.y) / (last.t - first.t)) * 1000 : 0;
    const projected = drag + ((velocity / 1000) * 0.99) / (1 - 0.99);
    const height = sheet?.offsetHeight ?? 400;
    if (projected > height * 0.4) close();
    drag = 0;
  }
  $effect(() => {
    if (!open) drag = 0;
  });

  // Render at the document root. A sheet opened from inside a glass surface (backdrop-filter), a transformed
  // or an isolated element would otherwise be sized and stacked against that element instead of the viewport:
  // e.g. a "tall" sheet inside the composer resolved 92% against the composer's height and was squashed at the bottom.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && close()} />

{#if open}
<div class="portal" use:portal>
  <div class="scrim" onclick={close} role="presentation" style:opacity={drag > 0 ? Math.max(0.2, 1 - drag / 500) : null}></div>
  <div
    bind:this={sheet}
    class="sheet glass-heavy"
    class:tall
    class:wide={layout.wide}
    class:dragging
    role="dialog"
    aria-modal="true"
    aria-label={title}
    style:transform={drag ? 'translateY(' + drag + 'px)' : null}
  >
    <div class="handle" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} role="presentation">
      {#if !layout.wide}<div class="grab"></div>{/if}
      {#if title}
        <header>
          <b>{title}</b>
          <button class="done press" onclick={close} onpointerdown={(e) => e.stopPropagation()}>Done</button>
        </header>
      {/if}
    </div>
    <div class="body">{@render children?.()}</div>
  </div>
</div>
{/if}

<style>
  .portal {
    display: contents;
  }
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 40;
    animation: fade 0.2s ease-out;
  }
  .sheet {
    position: fixed;
    left: 8px;
    right: 8px;
    bottom: 8px;
    z-index: 41;
    max-width: 640px;
    margin: 0 auto;
    max-height: min(84%, calc(var(--vvh) - 48px));
    display: flex;
    flex-direction: column;
    border-radius: 32px;
    animation: rise 0.42s var(--ease-out);
    transition: transform 0.36s var(--ease-out);
    transform-origin: 50% 100%;
  }
  .sheet.dragging {
    transition: none;
  }
  .sheet.tall {
    height: min(92%, calc(var(--vvh) - 24px));
    max-height: none;
  }
  /* Tablets: a centered form sheet that materializes in place. */
  .sheet.wide {
    left: 50%;
    right: auto;
    top: 50%;
    bottom: auto;
    width: min(560px, calc(100vw - 48px));
    max-height: min(720px, calc(var(--vvh) - 80px));
    translate: -50% -50%;
    transform-origin: 50% 50%;
    animation: materialize 0.32s var(--ease-out);
  }
  .sheet.wide.tall {
    height: min(720px, calc(var(--vvh) - 80px));
  }
  .handle {
    flex: none;
    touch-action: none;
    cursor: grab;
  }
  .wide .handle {
    cursor: default;
    padding-top: 8px;
  }
  .grab {
    width: 38px;
    height: 5px;
    border-radius: 3px;
    background: var(--line-strong);
    margin: 8px auto 2px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px 10px 22px;
  }
  header b {
    font-size: 17px;
    font-weight: 650;
    letter-spacing: -0.01em;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .done {
    flex: none;
    min-height: 36px;
    padding: 0 16px;
    border-radius: 999px;
    background: var(--fill);
    color: var(--accent-text);
    font-weight: 600;
    font-size: 15px;
  }
  .body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 0 18px calc(var(--safe-bottom) + 18px);
    flex: 1;
    min-height: 0;
  }
  .wide .body {
    padding-bottom: 22px;
  }
  @keyframes rise {
    from {
      transform: translateY(40px);
      opacity: 0;
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation: fade 0.2s ease;
    }
  }
</style>
