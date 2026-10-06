// ClipSync service worker: offline app shell + push notifications.
const CACHE = "clipsync-v1";
const SHELL = ["./", "index.html", "app.css", "app.js", "lib/supabase.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/apple-touch-icon.png"];
let unread = 0;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for the app's own files (so updates arrive), cache as fallback when offline.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "ClipSync", body: e.data?.text() }; }
  unread++;
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "ClipSync", {
      body: d.body || "New item", icon: "icons/icon-192.png", badge: "icons/icon-192.png",
      tag: d.id || undefined, data: { id: d.id },
    }),
    self.navigator?.setAppBadge?.(unread).catch(() => {}),
  ]));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data?.id;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.length) {
      const w = wins[0];
      w.postMessage({ type: "open", id });
      return w.focus();
    }
    return self.clients.openWindow("./" + (id ? "?open=" + encodeURIComponent(id) : ""));
  })());
});

self.addEventListener("message", (e) => {
  if (e.data?.type === "clear-badge") { unread = 0; self.navigator?.clearAppBadge?.().catch(() => {}); }
});
