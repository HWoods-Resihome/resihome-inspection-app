import Head from 'next/head';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * /install — on-device PWA install + self-diagnosis.
 *
 * Built for the field case where DevTools isn't available: open
 * resiwalk.com/install on the phone and it (a) shows a big one-tap Install
 * button, and (b) checks every Android-Chrome installability requirement live
 * and explains, in plain language, anything that's blocking the real app
 * install (vs. a plain shortcut). Public route (no auth needed).
 */

type Check = { id: string; label: string; ok: boolean | null; detail: string };

declare global {
  interface Window { __bipEvent?: (Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }) | null; }
}

function detectBrowser(): { isAndroid: boolean; isIOS: boolean; isChrome: boolean; isSafari: boolean; inApp: boolean; name: string } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  const isChrome = /Chrome\/|CriOS\//.test(ua) && !/Edg|OPR|SamsungBrowser|FxiOS/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|Android/.test(ua);
  const inApp = /FBAN|FBAV|Instagram|Line\/|Twitter|GSA\//.test(ua); // common in-app webviews
  let name = 'your browser';
  if (isIOS && isSafari) name = 'Safari';
  else if (/CriOS/.test(ua)) name = 'Chrome (iOS)';
  else if (isAndroid && /SamsungBrowser/.test(ua)) name = 'Samsung Internet';
  else if (isChrome) name = 'Chrome';
  return { isAndroid, isIOS, isChrome, isSafari, inApp, name };
}

export default function InstallPage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [standalone, setStandalone] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const deferredRef = useRef<Window['__bipEvent'] | null>(null);
  const br = useRef(detectBrowser());

  const loadImage = (src: string) => new Promise<boolean>((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(false), 6000);
    img.onload = () => { clearTimeout(t); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = src + (src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
  });

  const runChecks = useCallback(async () => {
    const out: Check[] = [];
    // 1. Standalone (already installed)
    const isStandalone = typeof window !== 'undefined'
      && (window.matchMedia?.('(display-mode: standalone)')?.matches === true || (navigator as any).standalone === true);
    setStandalone(isStandalone);

    // 2. HTTPS
    const https = typeof location !== 'undefined' && (location.protocol === 'https:' || location.hostname === 'localhost');
    out.push({ id: 'https', label: 'Served over HTTPS', ok: https, detail: https ? 'Secure connection.' : 'PWAs require https — open the site at https://resiwalk.com.' });

    // 3. Service worker — actively register, then confirm it's in control.
    let swOk = false; let swDetail = 'Service worker not supported by this browser.';
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/sw.js');
        const reg = await navigator.serviceWorker.ready.catch(() => null as any);
        const controller = navigator.serviceWorker.controller;
        swOk = !!(reg && (reg.active || controller));
        swDetail = swOk ? 'Active and in control.' : 'Registered — reload once so it takes control, then re-check.';
      } catch (e: any) { swDetail = 'Failed to register: ' + String(e?.message || e).slice(0, 80); }
    }
    out.push({ id: 'sw', label: 'Offline service worker active', ok: swOk, detail: swDetail });

    // 4. Manifest — fetch + parse + validate.
    let manifestOk = false; let manifestDetail = ''; let iconSrcs: string[] = [];
    try {
      const r = await fetch('/manifest.webmanifest', { cache: 'no-store' });
      if (!r.ok) { manifestDetail = `Manifest request failed (HTTP ${r.status}).`; }
      else {
        const m = await r.json();
        const hasName = !!(m.name || m.short_name);
        const displayOk = ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display);
        const icons = Array.isArray(m.icons) ? m.icons : [];
        const has192 = icons.some((i: any) => String(i.sizes || '').split(' ').includes('192x192') && (!i.purpose || /any/.test(i.purpose)));
        const has512 = icons.some((i: any) => String(i.sizes || '').split(' ').includes('512x512') && (!i.purpose || /any/.test(i.purpose)));
        iconSrcs = icons.map((i: any) => i.src).filter(Boolean);
        manifestOk = hasName && displayOk && has192 && has512;
        manifestDetail = manifestOk ? `OK (display: ${m.display}).`
          : [!hasName && 'missing name', !displayOk && `display is "${m.display}" (needs standalone)`, !has192 && 'no 192px "any" icon', !has512 && 'no 512px "any" icon'].filter(Boolean).join(', ');
      }
    } catch (e: any) { manifestDetail = 'Could not parse manifest: ' + String(e?.message || e).slice(0, 80); }
    out.push({ id: 'manifest', label: 'Valid web app manifest', ok: manifestOk, detail: manifestDetail });

    // 5. Icons actually load
    let iconsOk = false; let iconDetail = 'No icons to check.';
    if (iconSrcs.length) {
      const results = await Promise.all(iconSrcs.slice(0, 4).map((s) => loadImage(s)));
      iconsOk = results.every(Boolean);
      iconDetail = iconsOk ? `${results.length} icon(s) loaded.` : 'One or more icons failed to load (check the files in /public).';
    }
    out.push({ id: 'icons', label: 'App icons load', ok: iconsOk, detail: iconDetail });

    // 6. Install prompt available (the definitive signal it's installable)
    const hasPrompt = !!(window.__bipEvent) || canPrompt;
    out.push({
      id: 'prompt',
      label: 'Chrome reports it installable',
      ok: isStandalone ? true : (hasPrompt ? true : null),
      detail: isStandalone ? 'Already installed.' : hasPrompt
        ? 'Ready — tap Install below.'
        : 'Waiting for Chrome’s install signal. If everything above is ✓, give it a few seconds / interact with the page, then re-check.',
    });

    setChecks(out);
    if (window.__bipEvent) { deferredRef.current = window.__bipEvent; setCanPrompt(true); }
  }, [canPrompt]);

  useEffect(() => {
    const onBip = (e: Event) => { e.preventDefault(); (window as any).__bipEvent = e; deferredRef.current = e as any; setCanPrompt(true); };
    const onReady = () => { if (window.__bipEvent) { deferredRef.current = window.__bipEvent; setCanPrompt(true); } };
    const onInstalled = () => { setStandalone(true); setCanPrompt(false); setMsg('Installed! Find ResiWALK on your home screen.'); };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('bip-ready', onReady);
    window.addEventListener('appinstalled', onInstalled);
    void runChecks();
    const t = setTimeout(() => void runChecks(), 3000); // re-check after the SW settles / BIP fires
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('bip-ready', onReady);
      window.removeEventListener('appinstalled', onInstalled);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async () => {
    const d = deferredRef.current;
    if (!d) { setMsg(manualSteps()); return; }
    setBusy(true);
    try {
      d.prompt();
      const { outcome } = await d.userChoice;
      setMsg(outcome === 'accepted' ? 'Installing… check your home screen.' : 'Install dismissed. Tap Install again any time.');
      if (outcome === 'accepted') { deferredRef.current = null; (window as any).__bipEvent = null; setCanPrompt(false); }
    } catch { setMsg(manualSteps()); }
    finally { setBusy(false); }
  };

  const manualSteps = () => {
    const b = br.current;
    if (b.inApp) return 'Open this page in Chrome (or Safari on iPhone) first — in-app browsers can’t install apps. Tap the ⋯ menu and choose “Open in browser”.';
    if (b.isIOS) return 'On iPhone/iPad: tap the Share button (□↑) in Safari, then “Add to Home Screen”.';
    if (b.isAndroid) return 'On Android: tap Chrome’s ⋮ menu (top-right), then “Install app” (or “Add to home screen”). If it only offers a plain shortcut, run the check below — something above is ✗.';
    return 'Use Chrome on Android or Safari on iPhone to install. On desktop Chrome, use the install icon in the address bar.';
  };

  const allGreen = checks.length > 0 && checks.every((c) => c.ok === true);

  return (
    <div className="min-h-screen bg-gray-50 text-ink">
      <Head><title>Install ResiWALK</title><meta name="robots" content="noindex" /></Head>
      <div className="max-w-md mx-auto px-5 py-8">
        <div className="flex items-center gap-3 mb-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-192.png" alt="ResiWALK" className="w-14 h-14 rounded-2xl shadow" />
          <div>
            <h1 className="text-xl font-heading font-bold">Install ResiWALK</h1>
            <p className="text-sm text-gray-500">Add the app to your home screen — full-screen &amp; offline-ready.</p>
          </div>
        </div>

        {standalone ? (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 text-sm font-heading font-semibold">
            ✓ You’re running the installed app. You’re all set.
          </div>
        ) : (
          <>
            <button type="button" onClick={install} disabled={busy}
              className="w-full py-3.5 rounded-xl bg-brand text-white text-base font-heading font-bold shadow active:bg-brand-dark disabled:opacity-50">
              {busy ? 'Opening…' : canPrompt ? 'Install ResiWALK' : 'Install ResiWALK'}
            </button>
            <p className="text-xs text-gray-600 mt-2 leading-relaxed">{msg || manualSteps()}</p>
          </>
        )}

        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-heading font-bold text-gray-700">Readiness check</h2>
            <button type="button" onClick={() => void runChecks()} className="text-xs font-heading font-semibold text-brand">Re-check</button>
          </div>
          <ul className="space-y-2">
            {checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2.5 rounded-lg bg-white border border-gray-200 px-3 py-2.5">
                <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[12px] font-bold text-white ${c.ok === true ? 'bg-emerald-500' : c.ok === false ? 'bg-red-500' : 'bg-amber-400'}`}>
                  {c.ok === true ? '✓' : c.ok === false ? '✕' : '…'}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-heading font-semibold leading-tight">{c.label}</div>
                  <div className="text-[11.5px] text-gray-500 leading-snug">{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
          {allGreen && !standalone && (
            <p className="text-xs text-emerald-700 mt-3 font-heading font-semibold">Everything’s ready — tap “Install ResiWALK” above (or Chrome ⋮ → Install app).</p>
          )}
          <p className="text-[11px] text-gray-400 mt-4">
            Detected: {br.current.name}{br.current.inApp ? ' · in-app browser' : ''}. A shortcut you added before won’t upgrade — delete it and install from here.
          </p>
        </div>
      </div>
    </div>
  );
}
