// Web版だけで使う service worker（スマホアプリ版では登録しない）。ネットワーク優先、つながらないときはキャッシュ
const CACHE = "talk-eisaku-web-v8";
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(["./", "./manifest.webmanifest", "./icon-192.png"])).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("talk-eisaku") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase など外部への通信はそのまま
  e.respondWith(fetch(req)
    .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req).then(hit => hit || caches.match("./"))));
});
