import { useEffect, useRef, useState } from 'react';

/**
 * InstallButton — shows ONLY when Chrome actually has the native install prompt
 * to offer, and tapping it fires THAT (the real device pop-up). No custom
 * fallback dialog: a website can't conjure the native prompt, so when Chrome
 * isn't offering it (e.g. the PWA is still installed, or running as the app) the
 * button simply isn't shown. It returns automatically once Chrome re-offers
 * (after a FULL uninstall).
 */
type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

export function InstallButton({ className }: { className?: string }) {
  const deferredRef = useRef<BIP | null>(null);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || (navigator as any).standalone === true;
    if (standalone) return; // running as the installed app

    const pick = () => { const e = (window as any).__bipEvent as BIP | undefined; if (e) { deferredRef.current = e; setCanInstall(true); } };
    pick(); // event may have fired before mount (captured early in _document)

    const onBip = (e: Event) => { e.preventDefault(); (window as any).__bipEvent = e; deferredRef.current = e as BIP; setCanInstall(true); };
    const onReady = () => pick();
    const onInstalled = () => { deferredRef.current = null; (window as any).__bipEvent = null; setCanInstall(false); };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('bip-ready', onReady);
    window.addEventListener('appinstalled', onInstalled);
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
      d.prompt(); // ← the actual native device install pop-up
      const { outcome } = await d.userChoice;
      if (outcome === 'accepted') { deferredRef.current = null; (window as any).__bipEvent = null; setCanInstall(false); }
    } catch { /* noop */ }
  };

  return (
    <button type="button" onClick={onClick} className={className}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
      Install app
    </button>
  );
}
