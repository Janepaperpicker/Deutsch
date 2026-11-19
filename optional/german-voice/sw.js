// SPDX-License-Identifier: GPL-3.0-or-later
const prefix = 'deutsch-optional-voice-'
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
 const request = event.request, url = new URL(request.url)
 if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/optional-voice/releases/') || request.cache === 'no-store') return
 event.respondWith((async () => {
  for (const name of await caches.keys()) {
   if (!name.startsWith(prefix)) continue
   const cache = await caches.open(name)
   if (!await cache.match(new URL('/optional-voice/installation-complete', self.location.origin))) continue
   // Preview consent is a page parameter, not a different immutable asset.
   const response = await cache.match(new URL(url.pathname, url.origin).href)
   if (response) return response
  }
  return fetch(request)
 })())
})
