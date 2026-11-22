// uniharn service worker: shows Web Push notifications sent by the gateway.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'uniharn', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // The open app already shows its own in-app banner for this event.
      if (wins.some((c) => c.visibilityState === 'visible' && c.focused)) return;
      await self.registration.showNotification(data.title || 'uniharn', {
        body: data.body || '',
        tag: data.tag || data.type || 'uniharn',
        icon: 'icon.svg',
        badge: 'icon.svg',
        timestamp: data.at || Date.now(),
        renotify: data.type === 'approval_requested',
        requireInteraction: data.type === 'approval_requested',
        data: { route: data.route || null, id: data.id || null, type: data.type || null }
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = (event.notification.data && event.notification.data.route) || '';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of wins) {
        if ('focus' in c) {
          await c.focus();
          c.postMessage({ type: 'uniharn:navigate', route, id: event.notification.data && event.notification.data.id });
          return;
        }
      }
      await self.clients.openWindow(new URL('./' + route, self.registration.scope).href);
    })()
  );
});
