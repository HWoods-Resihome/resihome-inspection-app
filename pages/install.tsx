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
  const [det, setDet] = useState<Record<string, string>>({});
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

    // 2b. Browser context — in-app browsers and Incognito/Private tabs can't
    // install PWAs no matter what else passes.
    out.push({ id: 'ctx', label: 'Installable browser context', ok: br.current.inApp ? false : true,
      detail: br.current.inApp
        ? 'This is an in-app browser (opened inside another app) — it can’t install apps. Tap ⋯ → “Open in Chrome”.'
        : 'Standard tab. NOTE: Incognito / Private tabs cannot install PWAs — if you’re in one, switch to a normal Chrome tab.' });

    // 3. Service worker — register, then confirm it actually CONTROLS this page
    // (Chrome's install check needs a CONTROLLING SW, not just an active one). If
    // it's active but not controlling yet, a one-time reload makes it claim the
    // page so Chrome re-evaluates with the SW in control.
    let swOk = false; let swDetail = 'Service worker not supported by this browser.';
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('/sw.js');
        const reg = await navigator.serviceWorker.ready.catch(() => null as any);
        const controller = navigator.serviceWorker.controller;
        if (reg?.active && !controller && typeof sessionStorage !== 'undefined' && !sessionStorage.getItem('rw_sw_reload')) {
          sessionStorage.setItem('rw_sw_reload', '1');
          location.reload(); // gain control, then Chrome re-checks installability
          return;
        }
        swOk = !!controller;
        swDetail = controller ? 'Active and controlling this page.'
          : reg?.active ? 'Active but NOT controlling this page — close every resiwalk.com tab, fully reopen, then re-check.'
          : 'Registered but not active yet — reload.';
      } catch (e: any) { swDetail = 'Failed to register: ' + String(e?.message || e).slice(0, 80); }
    }
    out.push({ id: 'sw', label: 'Service worker controlling the page', ok: swOk, detail: swDetail });

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

    // 6. Install prompt available (Chrome's automatic one-tap signal). IMPORTANT:
    // Chrome suppresses this event for fully-installable sites too — if it was
    // dismissed before, on low page engagement, or if already installed. So when
    // the four hard criteria all pass, the app IS installable; point at the menu.
    const hasPrompt = !!(window.__bipEvent) || canPrompt;
    const hardReady = out.filter((c) => ['https', 'sw', 'manifest', 'icons'].includes(c.id)).every((c) => c.ok === true);
    out.push({
      id: 'prompt',
      label: 'Installable on this device',
      ok: isStandalone ? true : (hasPrompt || hardReady ? true : null),
      detail: isStandalone ? 'Already installed.'
        : hasPrompt ? 'Ready — tap Install above.'
        : hardReady ? 'All requirements pass ✓. If the Install button does nothing, Chrome has just suppressed its auto-prompt — install from the ⋮ menu → “Install app”. It will be the real app, not a shortcut.'
        : 'Waiting — fix the items above first.',
    });

    setChecks(out);
    if (window.__bipEvent) { deferredRef.current = window.__bipEvent; setCanPrompt(true); }

    // Raw signals — the definitive truth for diagnosing when checks disagree with
    // Chrome (screenshot this if install still won't work).
    let quota = 'n/a';
    try { const est = await (navigator as any).storage?.estimate?.(); if (est?.quota) quota = Math.round(est.quota / 1048576) + ' MB'; } catch { /* noop */ }
    setDet({
      browser: br.current.name,
      controllingSW: navigator.serviceWorker?.controller ? 'yes' : 'NO',
      installApi: ('onbeforeinstallprompt' in window) ? 'yes' : 'NO',
      promptFired: window.__bipEvent ? 'yes' : 'no',
      displayMode: window.matchMedia?.('(display-mode: standalone)')?.matches ? 'standalone' : 'browser',
      storageQuota: quota,
      ua: navigator.userAgent,
    });
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
    if (b.isAndroid) return 'On Android: tap Chrome’s ⋮ menu (top-right), then “Install app” (or “Add to home screen”). With the checks below all green this installs the REAL app. If it still only makes a shortcut: delete any old ResiWALK shortcut, then Chrome ⋮ → Settings → Site settings → resiwalk.com → Clear & reset, reload this page, and use the ⋮ menu again.';
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

          {/* Raw signals — screenshot this if install still won't work. */}
          {Object.keys(det).length > 0 && (
            <details className="mt-4">
              <summary className="text-xs font-heading font-semibold text-gray-600 cursor-pointer">Technical details (screenshot &amp; send if stuck)</summary>
              <div className="mt-2 rounded-lg bg-gray-900 text-gray-100 text-[10.5px] leading-relaxed font-mono p-3 break-words">
                <div>browser: {det.browser}</div>
                <div>controllingSW: {det.controllingSW}</div>
                <div>installApi: {det.installApi}</div>
                <div>promptFired: {det.promptFired}</div>
                <div>displayMode: {det.displayMode}</div>
                <div>storageQuota: {det.storageQuota}</div>
                <div className="mt-1 text-gray-400">ua: {det.ua}</div>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
