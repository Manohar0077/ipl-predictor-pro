self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event.data?.json() ?? {}));
});

async function handlePush(data) {
  const { title, body, icon = '/favicon.ico', tag, data: notifData = {} } = data;

  if (!tag) {
    // No grouping — show as-is (e.g. vote reminders, results)
    return self.registration.showNotification(title, {
      body,
      icon,
      badge: '/favicon.ico',
      data: notifData,
      vibrate: [200, 100, 200],
    });
  }

  // Grouped notification: collapse same-tag notifications into one
  const existing = await self.registration.getNotifications({ tag });
  const prevData = existing[0]?.data ?? {};
  const count = (prevData.count ?? 0) + 1;

  // Accumulate unique senders preserving order
  const prevSenders = prevData.senders ?? [];
  const sender = notifData.sender;
  const senders = sender && !prevSenders.includes(sender)
    ? [...prevSenders, sender]
    : prevSenders;

  const roomName = notifData.roomName ?? prevData.roomName ?? '';

  let finalTitle, finalBody;
  if (count === 1) {
    finalTitle = title;
    finalBody = body;
  } else {
    finalTitle = roomName ? `${roomName} · ${count} new messages` : `${count} new messages`;
    finalBody = senders.length > 0 ? senders.join(', ') : body;
  }

  // Close existing before replacing so the vibration/sound fires again
  existing.forEach(n => n.close());

  return self.registration.showNotification(finalTitle, {
    body: finalBody,
    icon,
    badge: '/favicon.ico',
    tag,
    renotify: true,
    data: { ...notifData, senders, count },
    vibrate: [200, 100, 200],
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow(url);
      })
  );
});
