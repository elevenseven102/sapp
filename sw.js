const CACHE = 'doc-scanner-v3';
const URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://docs.opencv.org/4.7.0/opencv.js',
  'https://cdn.jsdelivr.net/gh/ColonelParrot/jscanify@master/src/jscanify.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(URLS)));
});

self.addEventListener('fetch', event => {
  event.respondWith(caches.match(event.request).then(r => r || fetch(event.request)));
});