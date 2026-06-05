import { useEffect, useRef, useState } from 'react';

/**
 * InstallButton — fires Chrome's install prompt directly (no secondary page).
 *
 * Shows ONLY when the app can actually be installed and ISN'T already installed.
 * "Already installed" is detected three ways so it disappears for that user on
 * future logins:
 *   1. Running as the installed app (display-mode: standalone) → never shows.
 *   2. Chrome stops firing `beforeinstallprompt` once installed → no prompt to
 *      offer → stays hidden (this is the automatic, primary signal).
 *   3. A remembered flag (set on appinstalled / accepted) + getInstalledRelatedApps
 *      cover the gap right after install and across fresh sessions.
 */
type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
const INSTALLED_KEY = 'resiwalk_installed_v1';

export function InstallButton({ className }: { className?: string }) {
  const deferredRef = useRef<BIP | null>(null);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || (navigator as any).standalone === true;
    if (standalone) return;
    try { if (localStorage.getItem(INSTALLED_KEY)) return; } catch { /* storage off */ }

    const pick = () => {
      const e = (window as any).__bipEvent as BIP | undefined;
      if (e) { deferredRef.current = e; setCanInstall(true); }
    };
    pick(); // event may have fired before mount (captured early in _document)

    const onBip = (e: Event) => { e.preventDefault(); (window as any).__bipEvent = e; deferredRef.current = e as BIP; setCanInstall(true); };
    const onReady = () => pick();
    const onInstalled = () => {
      try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* noop */ }
      deferredRef.current = null; (window as any).__bipEvent = null; setCanInstall(false);
    };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('bip-ready', onReady);
    window.addEventListener('appinstalled', onInstalled);

    // Cross-session: if the PWA is already installed, keep the button hidden.
    (navigator as any).getInstalledRelatedApps?.()
      .then((apps: any[]) => { if (apps && apps.length) { try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* noop */ } setCanInstall(false); } })
      .catch(() => { /* unsupported — fine */ });

    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('bip-ready', onReady);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!canInstall) return null;

  const onClick = async () => {
    const d = deferredRef.current;
    if (!d) { setCanInstall(false); return; }
    try {
      d.prompt();
      const { outcome } = await d.userChoice;
      if (outcome === 'accepted') {
        try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* noop */ }
        deferredRef.current = null; (window as any).__bipEvent = null; setCanInstall(false);
      }
    } catch { /* noop */ }
  };

  return (
    <button type="button" onClick={onClick} className={className}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
      Install app
    </button>
  );
}
