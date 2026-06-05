import { useEffect, useRef, useState } from 'react';
import { useAppDialog } from '@/components/AppDialog';

/**
 * InstallButton — always-available install entry point.
 *
 * It stays visible whenever you're NOT already running the installed app
 * (display-mode: standalone), so you can always (re)install. On tap:
 *   - if Chrome handed us its install prompt → fire it (one-tap install);
 *   - else → explain exactly why and how (the prompt only fires when the app is
 *     installable AND not already installed). The #1 gotcha: removing the home-
 *     screen icon doesn't uninstall the PWA — the app is still installed, so
 *     Chrome won't re-offer until it's FULLY uninstalled.
 */
type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

export function InstallButton({ className }: { className?: string }) {
  const dialog = useAppDialog();
  const deferredRef = useRef<BIP | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || (navigator as any).standalone === true;
    if (standalone) { setHidden(true); return; } // already running as the app

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
        d.prompt();
        const { outcome } = await d.userChoice;
        if (outcome === 'accepted') { deferredRef.current = null; (window as any).__bipEvent = null; setHidden(true); }
      } catch { /* noop */ }
      return;
    }
    // No prompt available — tell the user precisely why.
    let installed = false;
    try { const apps = await (navigator as any).getInstalledRelatedApps?.(); installed = !!(apps && apps.length); } catch { /* unsupported */ }
    if (installed) {
      await dialog.alert(
        'ResiWALK looks like it’s still installed on this device, so the browser won’t offer to install it again.\n\n'
        + 'Removing the home-screen icon doesn’t uninstall it. To fully uninstall: long-press the ResiWALK icon → App info → Uninstall (or Settings → Apps → ResiWalk → Uninstall).\n\n'
        + 'Then reload this page and tap Install app again.'
      );
    } else {
      await dialog.alert(
        'To install ResiWALK:\n\n• Open Chrome’s ⋮ menu (top-right)\n• Tap “Install app” (or “Add to home screen”)\n\n'
        + 'If you don’t see it yet, wait a few seconds, reload, and try the menu again.'
      );
    }
  };

  return (
    <button type="button" onClick={onClick} className={className}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
      Install app
    </button>
  );
}
