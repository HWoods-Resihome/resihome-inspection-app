// Auto-fullscreen on web so the whole app uses the full screen and the mobile
// browser's URL/chrome bars get out of the way.
//
// The Fullscreen API can only be entered from a user gesture, so we request it
// on the FIRST tap/key after load. Constraints that keep it from being annoying
// or surprising:
//   • Touch (mobile) browsers only — a forced fullscreen on desktop, where the
//     URL bar isn't stealing space, would be jarring.
//   • Skipped in an installed PWA / the native shell — there's no browser chrome
//     to reclaim there.
//   • Requested ONCE per load; if the user manually exits fullscreen we don't
//     fight them by re-entering on the next tap.
// No-op where the API is unavailable (e.g. iOS Safari on the document element).
export function installAutoFullscreen(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const mq = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
  const isTouch = mq ? mq('(pointer: coarse)').matches : ('ontouchstart' in window);
  const standalone = (mq ? mq('(display-mode: standalone)').matches : false)
    || (window.navigator as any).standalone === true;
  if (!isTouch || standalone) return;

  const el: any = document.documentElement;
  const req: (() => Promise<void> | void) | undefined = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;

  function cleanup() {
    window.removeEventListener('pointerdown', tryFs);
    window.removeEventListener('keydown', tryFs);
  }
  function tryFs() {
    if (document.fullscreenElement) { cleanup(); return; }
    try {
      const p = req!.call(el);
      // Stop once we're actually in (success). On a rejected request keep
      // listening so the next gesture can retry.
      if (p && typeof (p as Promise<void>).then === 'function') {
        (p as Promise<void>).then(cleanup).catch(() => { /* not honored — keep listening */ });
      } else {
        cleanup();
      }
    } catch { /* keep listening for the next gesture */ }
  }

  window.addEventListener('pointerdown', tryFs, { passive: true });
  window.addEventListener('keydown', tryFs);
}
