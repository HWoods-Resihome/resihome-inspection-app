import { useEffect, useRef, useState } from 'react';

/**
 * InstallButton — always shown (unless already running as the installed app),
 * with a status dot:
 *   • amber (pulsing) = Chrome hasn't cleared the app as installable yet, so it
 *     can't be downloaded. Tapping does nothing — it keeps waiting.
 *   • green = Chrome has approved it (beforeinstallprompt is ready). Tap → the
 *     real device install pop-up.
 * It no longer disappears when tapped early.
 */
type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

export function InstallButton({ className }: { className?: string }) {
  const deferredRef = useRef<BIP | null>(null);
  const [ready, setReady] = useState(false);   // green when true, amber while false
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || (navigator as any).standalone === true;
    if (standalone) { setHidden(true); return; } // already the installed app

    const pick = () => { const e = (window as any).__bipEvent as BIP | undefined; if (e) { deferredRef.current = e; setReady(true); } };
    pick(); // event may have fired before mount (captured early in _document)

    const onBip = (e: Event) => { e.preventDefault(); (window as any).__bipEvent = e; deferredRef.current = e as BIP; setReady(true); };
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
    if (!d) return; // amber/not ready yet — keep waiting, don't vanish
    try {
      d.prompt(); // the real device install pop-up
      const { outcome } = await d.userChoice;
      if (outcome === 'accepted') { deferredRef.current = null; (window as any).__bipEvent = null; setHidden(true); }
    } catch { /* noop */ }
  };

  return (
    <button type="button" onClick={onClick} className={className}
      title={ready ? 'Ready to install' : 'Preparing… your browser hasn’t cleared the app for install yet'}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
      Install app
      <span
        aria-hidden
        className={`ml-1 inline-block w-2 h-2 rounded-full ${ready ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
      />
    </button>
  );
}
