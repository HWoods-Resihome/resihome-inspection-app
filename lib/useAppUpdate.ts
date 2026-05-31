/**
 * Service-worker registration + new-version detection for the field PWA.
 *
 * Two jobs:
 *   1. Register /sw.js so the app has an offline shell.
 *   2. Detect when a newer build has been deployed (by polling /api/version and
 *      comparing to the version this client booted with) and expose an
 *      `updateReady` flag so the UI can offer a one-tap reload. Field devices
 *      can otherwise sit on a stale build for days.
 */

import { useEffect, useState } from 'react';

const BOOT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '';
const POLL_MS = 5 * 60 * 1000; // every 5 min, plus on focus/visibility

export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  const register = () => { navigator.serviceWorker.register('/sw.js').catch(() => {/* non-fatal */}); };
  // Register after load so it never competes with first paint. If `load` has
  // already fired (it usually has by the time React mounts), register now.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

export function useAppUpdate(): { updateReady: boolean; latestVersion: string; reload: () => void } {
  const [updateReady, setUpdateReady] = useState(false);
  const [latestVersion, setLatestVersion] = useState(BOOT_VERSION);

  useEffect(() => {
    if (!BOOT_VERSION) return; // can't compare without a baked baseline
    let alive = true;

    const check = async () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const { version } = await res.json();
        if (alive && version && version !== BOOT_VERSION) {
          setLatestVersion(version);
          setUpdateReady(true);
        }
      } catch {/* offline / transient — try again later */}
    };

    check();
    const timer = setInterval(check, POLL_MS);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  const reload = () => {
    // Ask any waiting SW to take over, then hard-reload to the new build.
    try { navigator.serviceWorker?.controller?.postMessage('SKIP_WAITING'); } catch {/* noop */}
    window.location.reload();
  };

  return { updateReady, latestVersion, reload };
}
