/**
 * Service-worker registration + reliable new-version delivery for the field PWA.
 *
 * The hard problem with a hand-written SW: the file is byte-identical between
 * most deploys, so the browser never detects a "new" SW, never re-runs
 * activate(), and never purges stale caches — leaving users on an old build
 * until they delete + re-add the app. We fix that decisively:
 *
 *   1. Register the SW with a VERSIONED url (/sw.js?v=<build>). The script URL
 *      changes every deploy, so the browser always installs a fresh SW, which
 *      rotates its cache name and deletes the old caches on activate.
 *   2. Detect the waiting worker (updatefound / reg.waiting) and surface it as
 *      `updateReady` for a one-tap reload banner.
 *   3. Auto-apply a pending update when the app is REOPENED (becomes visible
 *      after being backgrounded a while) — the natural, non-disruptive moment
 *      to jump to the latest build, so most users never see the banner or have
 *      to do anything.
 *   4. /api/version polling stays as a backup signal.
 *
 * controllerchange → reload ONCE, but only for an update WE initiated (never on
 * the first-install claim), so there's no reload loop and no first-load refresh.
 */
import { useEffect, useState } from 'react';

const BOOT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '';
const POLL_MS = 5 * 60 * 1000;
const SW_URL = `/sw.js${BOOT_VERSION ? `?v=${BOOT_VERSION}` : ''}`;
const UPDATE_EVENT = 'resiwalk-sw-update';
// Only auto-apply on reopen if the app was backgrounded at least this long, so a
// quick app-switch back into an active inspection isn't interrupted by a reload.
const AUTO_APPLY_MIN_HIDDEN_MS = 15_000;

let _reg: ServiceWorkerRegistration | null = null;
let _updating = false;   // true once WE asked the waiting SW to take over
let _refreshing = false; // guards the controllerchange reload
let _hiddenAt = 0;

function announceUpdate() {
  try { window.dispatchEvent(new Event(UPDATE_EVENT)); } catch { /* noop */ }
}

/** Apply a pending update in ONE reload.
 *
 *  Common case (banner came from the /api/version poll while still on the old
 *  bundle): there's no waiting worker yet, because the new SW only registers once
 *  the NEW bundle loads. So we reload straight away — the navigation is
 *  network-first (fresh HTML + fresh hashed chunks), and the new bundle's SW
 *  installs with skipWaiting() so it activates in that same load. No second
 *  banner, no second reload.
 *
 *  Rare case (a worker is already waiting, e.g. a second tab installed it):
 *  promote it via SKIP_WAITING → controllerchange → reload once. */
function applyUpdate(): void {
  const reg = _reg;
  if (reg?.waiting) {
    _updating = true;
    try { reg.waiting.postMessage('SKIP_WAITING'); return; } catch { /* fall through to reload */ }
  }
  window.location.reload();
}

function watchInstalling(reg: ServiceWorkerRegistration) {
  const sw = reg.installing;
  if (!sw) return;
  sw.addEventListener('statechange', () => {
    // 'installed' WITH an existing controller ⇒ this is an update (not the
    // first install), and it's now waiting to take over.
    if (sw.state === 'installed' && navigator.serviceWorker.controller) announceUpdate();
  });
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!_updating || _refreshing) return; // ignore the first-install claim
    _refreshing = true;
    window.location.reload();
  });

  const register = async () => {
    try {
      // updateViaCache:'none' → the browser never serves /sw.js from its HTTP
      // cache, so reg.update() always sees a new build immediately (a big cause of
      // "needs two reloads to update").
      const reg = await navigator.serviceWorker.register(SW_URL, { updateViaCache: 'none' });
      _reg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) announceUpdate();
      reg.addEventListener('updatefound', () => watchInstalling(reg));

      const poke = () => { reg.update().catch(() => {}); };
      window.addEventListener('focus', poke);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { _hiddenAt = Date.now(); return; }
        // Became visible (app reopened): check for an update and auto-apply it
        // if one is waiting and we were away long enough.
        poke();
        const awayMs = _hiddenAt ? Date.now() - _hiddenAt : 0;
        if (reg.waiting && navigator.serviceWorker.controller && awayMs >= AUTO_APPLY_MIN_HIDDEN_MS) {
          applyUpdate();
        }
      });
      setInterval(poke, POLL_MS);
    } catch { /* non-fatal */ }
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

export function useAppUpdate(): { updateReady: boolean; latestVersion: string; reload: () => void } {
  const [updateReady, setUpdateReady] = useState(false);
  const [latestVersion, setLatestVersion] = useState(BOOT_VERSION);

  useEffect(() => {
    let alive = true;

    // Primary signal: a new SW is installed and waiting.
    const onSwUpdate = () => { if (alive) setUpdateReady(true); };
    window.addEventListener(UPDATE_EVENT, onSwUpdate);
    if (_reg?.waiting && navigator.serviceWorker?.controller) setUpdateReady(true);

    // Backup signal: the deployed version differs from what we booted with.
    const check = async () => {
      if (!BOOT_VERSION) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const { version } = await res.json();
        if (alive && version && version !== BOOT_VERSION) {
          setLatestVersion(version);
          setUpdateReady(true);
          _reg?.update().catch(() => {}); // nudge the SW to pick up the new build
        }
      } catch { /* offline / transient */ }
    };
    check();
    const timer = setInterval(check, POLL_MS);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener(UPDATE_EVENT, onSwUpdate);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  return { updateReady, latestVersion, reload: applyUpdate };
}
