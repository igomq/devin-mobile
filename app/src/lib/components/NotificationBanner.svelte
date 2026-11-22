<script lang="ts">
  import { notif, openNotification } from '#lib/notifications.svelte.ts';
</script>

{#if notif.banner}
  {@const n = notif.banner}
  <div class="banner glass {n.severity}" role="status" aria-live="polite">
    <button class="main" onclick={() => openNotification(n)}>
      <b>{n.title}</b>
      {#if n.body}<span>{notif.prefs?.hideSensitiveDetails && !n.local ? n.safeBody : n.body}</span>{/if}
    </button>
    <button class="close" aria-label="Dismiss" onclick={() => (notif.banner = null)}>×</button>
  </div>
{/if}

<style>
  .banner {
    position: fixed;
    top: calc(var(--safe-top) + 10px);
    left: 50%;
    transform: translateX(-50%);
    width: min(520px, calc(100vw - 24px));
    z-index: 70;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px 10px 12px 14px;
    border-radius: 18px;
    border-left: 4px solid var(--accent, #4c8dff);
    animation: drop 0.34s var(--ease-spring, ease-out);
  }
  .banner.success { border-left-color: #2fbf71; }
  .banner.warning { border-left-color: #ffb020; }
  .banner.error { border-left-color: #ff5c5c; }
  .main {
    flex: 1;
    min-width: 0;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    padding: 0;
    cursor: pointer;
  }
  .main span {
    color: var(--muted);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .close {
    background: none;
    border: 0;
    color: var(--muted);
    font-size: 20px;
    line-height: 1;
    padding: 2px 6px;
    cursor: pointer;
  }
  @keyframes drop {
    from { opacity: 0; transform: translate(-50%, -16px); }
  }
</style>
