import { useEffect, useRef, useState } from 'react';

/**
 * InstallPrompt — a one-tap "Install app" affordance for Android / desktop Chrome.
 *
 * Why: on Android, the browser MENU's "Add to home screen" silently creates a
 * plain shortcut (opens in Chrome) unless the page is deemed installable at that
 * instant. When the PWA criteria ARE met, Chrome fires `beforeinstallprompt`; we
 * capture it and surface our own "Install" button that calls `prompt()`, which
 * triggers the real WebAPK install — a standalone, offline-capable app icon on
 * the home screen (not a shortcut). This removes all ambiguity vs. the menu.
 *
 * iOS doesn't fire `beforeinstallprompt` (install is Share → Add to Home Screen,
 * which already works), so nothing shows there. Hidden when already running
 * standalone, and dismissal is remembered.
 */
const DISMISS_KEY = 'resiwalk_install_dismissed_v1';

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)')?.matches === true
    || (navigator as any).standalone === true;
}

export function InstallPrompt() {
  const deferredRef = useRef<BIPEvent | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isStandalone()) return; // already installed → nothing to offer
    try { if (localStorage.getItem(DISMISS_KEY)) return; } catch { /* storage off */ }

    // The event may have ALREADY fired and been stashed by the early-capture
    // script in _document (it often fires before React hydrates). Pick it up.
    const pickUp = () => {
      const ev = (window as any).__bipEvent as BIPEvent | undefined;
      if (ev) { deferredRef.current = ev; setShow(true); }
    };
    pickUp();

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();              // stop Chrome's default mini-infobar
      deferredRef.current = e as BIPEvent;
      (window as any).__bipEvent = e;
      setShow(true);
    };
    const onInstalled = () => {
      deferredRef.current = null;
      (window as any).__bipEvent = null;
      setShow(false);
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
    };
    window.addEventListener('bip-ready', pickUp);          // early-capture signal
    window.addEventListener('beforeinstallprompt', onBeforeInstall); // direct (fallback)
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('bip-ready', pickUp);
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!show) return null;

  const install = async () => {
    const d = deferredRef.current;
    if (!d) { setShow(false); return; }
    try {
      d.prompt();
      await d.userChoice; // 'accepted' kicks off the WebAPK install; 'dismissed' just closes
    } catch { /* noop */ }
    deferredRef.current = null;
    setShow(false);
  };
  const dismiss = () => {
    setShow(false);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 px-3 pointer-events-none"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}
    >
      <div className="pointer-events-auto mx-auto max-w-md flex items-center gap-3 rounded-2xl bg-ink text-white shadow-2xl ring-1 ring-white/10 px-3 py-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon-192.png" alt="" className="w-9 h-9 rounded-lg shrink-0" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-heading font-bold">Install ResiWALK</div>
          <div className="text-[11px] text-white/70">Adds the app to your home screen — full-screen &amp; offline-ready.</div>
        </div>
        <button type="button" onClick={install}
          className="shrink-0 px-3.5 py-2 rounded-lg bg-brand text-white text-sm font-heading font-semibold active:bg-brand-dark">
          Install
        </button>
        <button type="button" onClick={dismiss} aria-label="Dismiss"
          className="shrink-0 w-8 h-8 rounded-lg text-white/70 hover:text-white text-lg leading-none flex items-center justify-center">×</button>
      </div>
    </div>
  );
}
