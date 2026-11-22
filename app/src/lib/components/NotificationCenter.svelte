<script lang="ts">
  import { notif, openNotification, markRead, clearNotifications, EVENT_LABELS } from '#lib/notifications.svelte.ts';
  import { go } from '#lib/ui.svelte.ts';

  const when = (at: number) => {
    const s = Math.round((Date.now() - at) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return new Date(at).toLocaleDateString();
  };
</script>

{#if notif.centerOpen}
  <div class="scrim" role="presentation" onclick={() => (notif.centerOpen = false)}></div>
  <div class="center glass" role="dialog" aria-label="Notifications">
    <header>
      <b>Notifications</b>
      <div class="actions">
        <button class="link" disabled={!notif.unreadCount} onclick={() => markRead()}>Mark all read</button>
        <button class="link" disabled={!notif.items.length} onclick={clearNotifications}>Clear</button>
        <button class="link" onclick={() => { notif.centerOpen = false; go('#/settings'); }}>Settings</button>
      </div>
    </header>
    {#if !notif.items.length}
      <p class="empty">No notifications yet. Approvals, finished or failed runs, conflicts and lost connections show up here.</p>
    {:else}
      <ul>
        {#each notif.items as n (n.id)}
          <li class:unread={!n.read}>
            <button class="item {n.severity}" onclick={() => openNotification(n)}>
              <span class="kind">{EVENT_LABELS[n.type]}</span>
              <b>{n.title}</b>
              {#if n.body}<span class="body">{n.body}</span>{/if}
              <time>{when(n.at)}</time>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 64; background: var(--scrim); }
  .center {
    position: fixed;
    z-index: 65;
    top: calc(var(--safe-top) + 58px);
    right: 12px;
    width: min(420px, calc(100vw - 24px));
    max-height: min(70vh, calc(var(--vvh, 100vh) - var(--safe-top) - 80px));
    display: flex;
    flex-direction: column;
    border-radius: 20px;
    overflow: hidden;
  }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  .actions { display: flex; gap: 10px; }
  .link { background: none; border: 0; color: var(--accent-text, var(--text)); font: inherit; font-size: 0.85em; cursor: pointer; padding: 0; opacity: 0.85; }
  .link:disabled { opacity: 0.35; cursor: default; }
  .empty { padding: 18px; color: var(--muted); margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
  li + li { border-top: 1px solid var(--line); }
  .item { position: relative; width: 100%; text-align: left; display: flex; flex-direction: column; gap: 2px; padding: 10px 14px 10px 18px; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; }
  li.unread .item::before { content: ''; position: absolute; left: 6px; top: 16px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  .item.error .kind { color: var(--red); }
  .item.warning .kind { color: var(--amber); }
  .item.success .kind { color: var(--green); }
  .kind { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .body { color: var(--muted); font-size: 0.9em; overflow-wrap: anywhere; }
  time { position: absolute; right: 14px; top: 10px; font-size: 0.75em; color: var(--muted); }
</style>
