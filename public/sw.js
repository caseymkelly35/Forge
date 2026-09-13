// FORGE service worker.
//
// Right now this only does two things: makes the app installable
// (required for that alone) and is ready to receive and display a
// push notification the moment the server side sends one — nothing
// sends one yet. This file needs no changes when that's built later.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Fires when a push message arrives from the server, even if no tab
// is open. Shows a native OS notification built from whatever payload
// the server sends.
self.addEventListener("push", (event) => {
  let data = { title: "FORGE", body: "You have a new update.", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // non-JSON payload — fall back to the defaults above
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

// Fires when the person taps the notification — focuses an already-open
// tab if one exists, otherwise opens a fresh one to the right place.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
