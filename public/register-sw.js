/**
 * Registers the service worker, so the tool works with no signal.
 *
 * A separate file rather than an inline <script> in index.html: that is how
 * the rest of the fleet does it, and those sites run under a `script-src
 * 'self'` policy which blocks inline script outright -- silently, so the page
 * renders and the app is simply never installable. Keeping the same shape
 * here means a policy can be added to this site later without quietly
 * un-installing it.
 *
 * Failure is logged and dropped. No service worker means no offline use;
 * everything else the page does still works.
 */
window.addEventListener('load', () => {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((error) => {
    console.warn('offline support unavailable:', error);
  });
});
