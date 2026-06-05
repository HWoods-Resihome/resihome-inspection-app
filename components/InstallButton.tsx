import { useEffect, useRef, useState } from 'react';

/**
 * InstallButton — fires Chrome's install prompt directly (no secondary page).
 *
 * Shows ONLY when Chrome currently has an install prompt to offer, which is the
 * self-correcting signal for "installable & not already installed":
 *   - Not installed + installable → Chrome fires `beforeinstallprompt` → shown.
 *   - Already installed → Chrome does NOT fire it → hidden (also hidden when the
 *     page is opened as the installed app, i.e. display-mode: standalone).
 *   - User uninstalls → Chrome fires it again on the next visit → button RETURNS.
 *
 * (Earlier this used a sticky localStorage "installed" flag, which never cleared
 * on uninstall and wrongly hid the button forever — removed.)
 */
type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

export function InstallButton({ className }: { className?: string }) {
  const deferredRef = useRef<BIP | null>(null);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || (navigator as any).standalone === true;
    if (standalone) return; // running as the installed app → never show

    const pick = () => {
      const e = (window as any).__bipEvent as BIP | undefined;
      if (e) { deferredRef.current = e; setCanInstall(true); }
    };
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
      d.prompt();
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
