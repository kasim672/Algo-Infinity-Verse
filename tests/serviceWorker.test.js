// tests/serviceWorker.test.js
//
// Verifies sw.js's caching strategy (Issue #2566): cache-first for static
// assets, network-only for /api/*, network-first-with-cache-fallback for
// navigation, offline.html as the last resort, cache versioning/cleanup on
// activate, and — critically — that pages requiring authentication are
// never cached (server.js gates them server-side; caching one would let a
// signed-out/offline user bypass that gate).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const swCode = fs.readFileSync(path.resolve(__dirname, '../sw.js'), 'utf-8');

function createMockCache(initialEntries = new Map()) {
  const store = initialEntries;
  return {
    _store: store,
    match: jest.fn(async (request) => {
      const key = typeof request === 'string' ? request : request.url;
      return store.get(key) || undefined;
    }),
    put: jest.fn(async (request, response) => {
      const key = typeof request === 'string' ? request : request.url;
      store.set(key, response);
    }),
    add: jest.fn(async (url) => {
      store.set(url, { url, ok: true });
    }),
    delete: jest.fn(async (request) => {
      const key = typeof request === 'string' ? request : request.url;
      return store.delete(key);
    }),
    keys: jest.fn(async () => Array.from(store.keys()).map((url) => ({ url }))),
  };
}

function createResponse({ ok = true, bodyText = '<html></html>' } = {}) {
  return {
    ok,
    status: ok ? 200 : 500,
    clone() {
      return createResponse({ ok, bodyText });
    },
    text: async () => bodyText,
  };
}

describe('sw.js', () => {
  let self;
  let listeners;
  let caches;
  let fetchMock;
  let cacheStores;

  beforeEach(() => {
    listeners = {};
    cacheStores = new Map();

    caches = {
      open: jest.fn(async (name) => {
        if (!cacheStores.has(name)) cacheStores.set(name, createMockCache(new Map()));
        return cacheStores.get(name);
      }),
      keys: jest.fn(async () => Array.from(cacheStores.keys())),
      delete: jest.fn(async (name) => cacheStores.delete(name)),
      match: jest.fn(async (request) => {
        const key = typeof request === 'string' ? request : request.url;
        for (const cache of cacheStores.values()) {
          if (cache._store.has(key)) return cache._store.get(key);
        }
        return undefined;
      }),
    };

    fetchMock = jest.fn();
    global.fetch = fetchMock;
    global.caches = caches;
    global.Response = {
      error: () => ({ ok: false, status: 0, isErrorResponse: true }),
    };
    global.URL = URL;

    self = {
      addEventListener: jest.fn((type, handler) => {
        listeners[type] = handler;
      }),
      location: { origin: 'https://example.com' },
      skipWaiting: jest.fn(async () => {}),
      clients: { claim: jest.fn(async () => {}) },
    };
    global.self = self;

    // eslint-disable-next-line no-eval
    eval(swCode);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete global.fetch;
    delete global.caches;
    delete global.Response;
    delete global.self;
  });

  function makeFetchEvent({ url, method = 'GET', mode = 'navigate', destination = 'document' }) {
    let respondWithPromise;
    const request = { url, method, mode, destination };
    const event = {
      request,
      respondWith: jest.fn((promise) => {
        respondWithPromise = promise;
      }),
    };
    listeners.fetch(event);
    return { event, getResult: () => respondWithPromise };
  }

  describe('install', () => {
    it('precaches the shell and calls skipWaiting', async () => {
      const event = { waitUntil: jest.fn() };
      listeners.install(event);
      await event.waitUntil.mock.calls[0][0];

      expect(self.skipWaiting).toHaveBeenCalled();
      const staticCache = await caches.open('aiv-static-v1');
      expect(staticCache.add).toHaveBeenCalledWith('/index.html');
      expect(staticCache.add).toHaveBeenCalledWith('/offline.html');
    });
  });

  describe('activate', () => {
    it('deletes old aiv-* caches that do not match the current version', async () => {
      caches.keys.mockResolvedValueOnce(['aiv-static-v0', 'aiv-pages-v0', 'aiv-static-v1', 'unrelated-cache']);

      const event = { waitUntil: jest.fn() };
      listeners.activate(event);
      await event.waitUntil.mock.calls[0][0];

      expect(caches.delete).toHaveBeenCalledWith('aiv-static-v0');
      expect(caches.delete).toHaveBeenCalledWith('aiv-pages-v0');
      expect(caches.delete).not.toHaveBeenCalledWith('aiv-static-v1');
      expect(caches.delete).not.toHaveBeenCalledWith('unrelated-cache');
      expect(self.clients.claim).toHaveBeenCalled();
    });
  });

  describe('fetch - routing', () => {
    it('does not intercept non-GET requests', () => {
      const { event } = makeFetchEvent({ url: 'https://example.com/api/login', method: 'POST' });
      expect(event.respondWith).not.toHaveBeenCalled();
    });

    it('does not intercept cross-origin requests', () => {
      const { event } = makeFetchEvent({ url: 'https://cdn.example.org/font.woff2', destination: 'font' });
      expect(event.respondWith).not.toHaveBeenCalled();
    });

    it('routes /api/* requests network-only, never touching the cache', async () => {
      fetchMock.mockResolvedValueOnce(createResponse());
      const { getResult } = makeFetchEvent({
        url: 'https://example.com/api/leaderboard',
        mode: 'same-origin',
        destination: '',
      });

      await getResult();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(caches.open).not.toHaveBeenCalled();
    });
  });

  describe('fetch - static assets (cache-first)', () => {
    it('serves from cache when present, without hitting the network', async () => {
      const cachedResponse = createResponse();
      const staticCache = await caches.open('aiv-static-v1');
      await staticCache.put('https://example.com/styles.css', cachedResponse);

      const { getResult } = makeFetchEvent({
        url: 'https://example.com/styles.css',
        mode: 'no-cors',
        destination: 'style',
      });

      const result = await getResult();
      expect(result).toBe(cachedResponse);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to network and populates the cache on a miss', async () => {
      const networkResponse = createResponse();
      fetchMock.mockResolvedValueOnce(networkResponse);

      const { getResult } = makeFetchEvent({
        url: 'https://example.com/theme.js',
        mode: 'no-cors',
        destination: 'script',
      });

      const result = await getResult();
      expect(result).toBe(networkResponse);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const staticCache = await caches.open('aiv-static-v1');
      expect(staticCache.put).toHaveBeenCalled();
    });
  });

  describe('fetch - navigation (network-first, cache fallback, offline.html last resort)', () => {
    it('caches a successful navigation response', async () => {
      fetchMock.mockResolvedValueOnce(createResponse({ bodyText: '<html><body>Home</body></html>' }));

      const { getResult } = makeFetchEvent({ url: 'https://example.com/index.html' });
      await getResult();

      const pagesCache = await caches.open('aiv-pages-v1');
      expect(pagesCache.put).toHaveBeenCalled();
    });

    it('does NOT cache a page carrying the auth-required meta tag', async () => {
      const authRequiredHtml =
        '<html><head><meta name="auth-required" content="true"></head><body>Settings</body></html>';
      fetchMock.mockResolvedValueOnce(createResponse({ bodyText: authRequiredHtml }));

      const { getResult } = makeFetchEvent({ url: 'https://example.com/pages/auth/setting.html' });
      await getResult();

      const pagesCache = await caches.open('aiv-pages-v1');
      expect(pagesCache.put).not.toHaveBeenCalled();
    });

    it('falls back to a previously cached page when the network fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('offline'));
      const pagesCache = await caches.open('aiv-pages-v1');
      const cachedPage = createResponse({ bodyText: '<html><body>Cached</body></html>' });
      await pagesCache.put('https://example.com/pages/practice/problems.html', cachedPage);

      const { getResult } = makeFetchEvent({ url: 'https://example.com/pages/practice/problems.html' });
      const result = await getResult();

      expect(result).toBe(cachedPage);
    });

    it('falls back to offline.html when the network fails and nothing is cached for that page', async () => {
      fetchMock.mockRejectedValueOnce(new Error('offline'));
      const staticCache = await caches.open('aiv-static-v1');
      const offlinePage = createResponse({ bodyText: "<html><body>You're offline</body></html>" });
      await staticCache.put('/offline.html', offlinePage);

      const { getResult } = makeFetchEvent({ url: 'https://example.com/pages/some-uncached-page.html' });
      const result = await getResult();

      expect(result).toBe(offlinePage);
    });
  });
});
