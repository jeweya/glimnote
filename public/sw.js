/**
 * 应用外壳缓存：断网时仍能打开界面（笔记本身在 OPFS 里）。
 * - 页面导航走「网络优先」，拿到新版本后顺手更新缓存；
 * - 带哈希的静态资源走「缓存优先」，命中后不再发请求。
 */
const CACHE = 'glimnote-shell-v2';
const SHELL = ['/', '/index.html', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** 页面加载完成后把已加载的 JS / CSS 补进缓存，保证断网重开可用 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'cache-assets' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(data.urls.map((url) => cache.add(url).catch(() => undefined))))
      .catch(() => undefined),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        // ignoreVary：部分静态服务器会返回 Vary: Origin，而模块脚本带 crossorigin 属性，
        // 严格匹配会错过缓存，断网时就会出现「有 HTML 没 JS」。
        .catch(
          async () =>
            (await caches.match('/index.html', { ignoreVary: true })) ||
            (await caches.match('/', { ignoreVary: true })) ||
            Response.error(),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
