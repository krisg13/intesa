// Intesa service worker: keep the app shell so it opens offline, and refresh it in the background.
const VERSION = 'intesa-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest',
  './fonts/et-book-roman-line-figures.woff', './fonts/et-book-display-italic-old-style-figures.woff', './fonts/et-book-bold-line-figures.woff',
  './icons/icon-192.png', './icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, {mode: u.startsWith('http') ? 'no-cors' : 'same-origin'}))))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(res => { if (res && (res.ok || res.type === 'opaque')) caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; }).catch(() => hit);
    return hit || net;
  }));
});
