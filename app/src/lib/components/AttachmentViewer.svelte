<script lang="ts">
  import { markdown } from '#lib/format.ts';
  import { isMarkdown } from '#lib/textfile.ts';
  import Icon from './Icon.svelte';

  export type Viewed = { kind: 'image'; src: string; name: string } | { kind: 'text'; name: string; mimeType: string; text: string };
  let { item = $bindable(null) }: { item: Viewed | null } = $props();
  const close = () => (item = null);

  function key(e: KeyboardEvent) {
    if (item && e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

<svelte:window onkeydown={key} />

{#if item}
  <div class="viewer" class:image={item.kind === 'image'} role="dialog" aria-modal="true" aria-label={item.name}>
    <header>
      <span class="name">{item.name}</span>
      <button class="close" onclick={close} aria-label="Close"><Icon name="x" size={18} /></button>
    </header>
    {#if item.kind === 'image'}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="stage" onclick={(e) => e.target === e.currentTarget && close()}>
        <img src={item.src} alt={item.name} />
      </div>
    {:else if isMarkdown(item.name, item.mimeType)}
      <div class="doc md">{@html markdown(item.text)}</div>
    {:else}
      <pre class="doc mono">{item.text}</pre>
    {/if}
  </div>
{/if}

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    height: var(--vvh);
    background: var(--bg);
    padding-top: var(--safe-top);
  }
  .viewer.image {
    background: rgba(0, 0, 0, 0.92);
    color: #fff;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 8px 8px 16px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
  }
  .close {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }
  .stage {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    overflow: auto;
    touch-action: pinch-zoom pan-x pan-y;
  }
  .stage img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .doc {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: 4px 16px calc(16px + env(safe-area-inset-bottom));
    -webkit-user-select: text;
    user-select: text;
  }
  pre.doc {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 13px;
  }
</style>
