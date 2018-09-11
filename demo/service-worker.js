importScripts('../build/sw-runtime.js');

self.addEventListener('fetch', (event) => {
  event.respondWith(goog.appCacheBehavior.fetch(event));
});
