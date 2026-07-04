const CACHE_NAME = 'scanbot-pwa-v1';
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/scanbot-web-sdk@7.0.0/bundle/ScanbotSDK.ui2.min.js',
  // Кеширование всех ресурсов движка (можно перечислить или использовать динамическое добавление)
  // Для простоты мы используем стратегию: при установке кешируем только основные файлы,
  // а остальные (engine) будут добавляться в кеш по мере использования.
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(URLS_TO_CACHE))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      // Возвращаем из кеша, если есть, иначе идём в сеть и сохраняем в кеш
      return cachedResponse || fetch(event.request).then(networkResponse => {
        return caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, networkResponse.clone());
          return networkResponse;
        });
      });
    })
  );
});