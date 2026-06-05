import { useEffect, useRef, useState } from 'react';

/**
 * InstallButton — always shown (unless already running as the installed app).
 * Tapping it fires the real device install prompt when Chrome has one ready; if
 * Chrome has nothing to offer (e.g. the app is still installed), the button just
 * hides itself for the rest of this session. No custom popup.
 */
type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

export function InstallButton({ className }: { className?: string }) {
  const deferredRef = useRef<BIP | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || (navigator as any).standalone === true;
    if (standalone) { setHidden(true); return; } // already the installed app

    const pick = () => { const e = (window as any).__bipEvent as BIP | undefined; if (e) deferredRef.current = e; };
    pick(); // event may have fired before mount (captured early in _document)

    const onBip = (e: Event) => { e.preventDefault(); (window as any).__bipEvent = e; deferredRef.current = e as BIP; };
    const onReady = () => pick();
    const onInstalled = () => { deferredRef.current = null; (window as any).__bipEvent = null; setHidden(true); };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('bip-ready', onReady);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('bip-ready', onReady);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (hidden) return null;

  const onClick = async () => {
    const d = deferredRef.current;
    if (d) {
      try {
        d.prompt(); // the real device install pop-up
        const { outcome } = await d.userChoice;
        if (outcome === 'accepted') { deferredRef.current = null; (window as any).__bipEvent = null; setHidden(true); }
      } catch { setHidden(true); }
      return;
    }
    // Chrome has no prompt to offer right now → disappear for this session.
    setHidden(true);
  };

  return (
    <button type="button" onClick={onClick} className={className}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
      Install app
    </button>
  );
}
