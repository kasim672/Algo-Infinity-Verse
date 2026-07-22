// Issue #2566: register the caching service worker (sw.js). Registration is
// wrapped defensively — any failure here must never block app init, and we
// intentionally register after the page has finished loading so the SW
// doesn't compete with the initial page's own network requests.
export function initServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // file:// pages (opened directly without the Node server) can't register
  // a service worker at all — avoid the console error.
  if (typeof location !== 'undefined' && location.protocol === 'file:') return;

  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  };

  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}
window.initServiceWorker = initServiceWorker;
