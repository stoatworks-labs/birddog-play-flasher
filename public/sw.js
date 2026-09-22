// Service worker: offline use, without the risk of a permanently stale app.
//
// The whole point of installing this tool to a home screen is having it in a
// loading bay with no signal. That means caching. It also means the classic
// service-worker failure is now available to us: a cached shell that outlives
// every deploy, so the app silently never updates again and there is nothing
// the user can do about it short of clearing site data.
//
// The strategy below is chosen to make that failure impossible rather than
// unlikely:
//
//   navigations     -> network first, cache as fallback
//   everything else -> network first, cache as fallback
//
// A navigation always asks the network first, so an online user is always on
// the current build; the cache only answers when the network does not. And
// because asset URLs change with their content, a new build fetches new URLs
// and cannot be served yesterday's JavaScript.
//
// Bump CACHE when the caching behaviour itself changes. It does not need
// bumping per deploy -- the hashed filenames already handle that -- and old
// caches are deleted on activate, so a bump costs one cold fetch.

const CACHE = 'birddog-play-flasher-v1';

// Enough to boot offline. Everything else arrives through runtime caching.
//
// Nothing here is content-hashed or bundled, so every file has to be named here or it is simply missing when it
// matters. Naming it is only half the job: the last branch of the fetch
// handler is what reads these back, and without that branch an install
// populates a cache nothing ever consults.
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/app.js',
  '/crc.js',
  '/ext2.js',
  '/gpt.js',
  '/inject.js',
  '/partwrite.js',
  '/plan.js',
  '/rkboot.js',
  '/rkfw.js',
  '/rockusb.js',
];

self.addEventListener('install', (event) => {
  // addAll rejects the whole install if any one entry 404s, which would leave
  // the old worker in place -- correct, but silent. Fetch individually so one
  // missing file cannot block an install.
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => {})),
      );
      // Take over immediately rather than waiting for every tab to close: the
      // strategy here is safe to swap under a running page, and waiting is how
      // an update sits unapplied for days.
      await self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch anything but same-origin reads. POSTs are not cacheable, and
  // a cross-origin response is not ours to reason about.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put('/', fresh.clone());
          return fresh;
        } catch {
          // Offline. Any cached navigation will do -- this is a single-page
          // app, so '/' is the whole shell.
          const cached = (await caches.match(request)) || (await caches.match('/'));
          if (cached) return cached;
          throw new Error('offline and nothing cached');
        }
      })(),
    );
    return;
  }

  // Everything else same-origin: the shell files above, and anything else the
  // page asks for by a stable name. The network wins whenever there is one,
  // because none of these URLs carry their own version and a cached copy could
  // be any age. The cache answers only when the fetch throws.
  //
  // Falling through here instead -- letting the browser fetch normally -- is
  // the quiet way to have no offline support at all: install would fill a
  // cache that the fetch handler never reads, the page would load with no
  // signal, and then every script it pulls from the site root would fail.
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok && SHELL.includes(url.pathname)) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
