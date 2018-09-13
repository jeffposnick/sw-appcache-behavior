importScripts('../build/sw-runtime.js');

self.addEventListener('fetch', (event) => {
  event.respondWith(appcache.generateResponse(event));
});
