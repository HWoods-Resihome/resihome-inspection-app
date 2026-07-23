import Head from 'next/head';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SW_URL } from '@/lib/useAppUpdate';

/**
 * /install — on-device PWA install + self-diagnosis (no DevTools needed).
 * Public route. Open resiwalk.com/install on the phone: it shows an Install
 * button and a live readiness check that pinpoints, in plain language, anything
 * stopping the real install — plus a raw "Technical details" block to screenshot.
 */
type Check = { id: string; label: string; ok: boolean | null; detail: string };
declare global { interface Window { __bipEvent?: (Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }) | null; } }

function detectBrowser() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|Android/.test(ua);
  const inApp = /FBAN|FBAV|Instagram|Line\/|Twitter|GSA\/|; wv\)/.test(ua);
  let name = 'your browser';
  if (/CriOS/.test(ua)) name = 'Chrome (iOS)';
  else if (isAndroid && /SamsungBrowser/.test(ua)) name = 'Samsung Internet';
  else if (/Chrome\//.test(ua) && !/Edg|OPR/.test(ua)) name = 'Chrome';
  else if (isIOS && isSafari) name = 'Safari';
  return { isAndroid, isIOS, isSafari, inApp, name };
}

export default function InstallPage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [standalone, setStandalone] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const [msg, setMsg] = useState('');
  const [iosSheet, setIosSheet] = useState(false);
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
    const isStandalone = typeof window !== 'undefined'
      && (window.matchMedia?.('(display-mode: standalone)')?.matches === true || (navigator as any).standalone === true);
    setStandalone(isStandalone);

    const https = typeof location !== 'undefined' && (location.protocol === 'https:' || location.hostname === 'localhost');
    out.push({ id: 'https', label: 'Served over HTTPS', ok: https, detail: https ? 'Secure connection.' : 'Open the site at https://resiwalk.com.' });

    out.push({ id: 'ctx', label: 'Installable browser context', ok: br.current.inApp ? false : true,
      detail: br.current.inApp ? 'In-app browser — can’t install. Open in Chrome.' : 'Standard tab. (Incognito/Private tabs can’t install — use a normal tab.)' });

    // Service worker — must be CONTROLLING this page.
    let swOk = false; let swDetail = 'Service worker not supported.';
    if ('serviceWorker' in navigator) {
      try {
        // Register the SAME versioned URL as the main app (lib/useAppUpdate) — a
        // bare '/sw.js' here would replace the versioned registration and defeat
        // per-deploy update detection (stale JS served after deploy).
        await navigator.serviceWorker.register(SW_URL, { updateViaCache: 'none' });
        const reg = await navigator.serviceWorker.ready.catch(() => null as any);
        const controller = navigator.serviceWorker.controller;
        if (reg?.active && !controller && typeof sessionStorage !== 'undefined' && !sessionStorage.getItem('rw_sw_reload')) {
          sessionStorage.setItem('rw_sw_reload', '1'); location.reload(); return;
        }
        swOk = !!controller;
        swDetail = controller ? 'Active and controlling this page.' : reg?.active ? 'Active but NOT controlling — close all resiwalk.com tabs and reopen.' : 'Registered, not active yet — reload.';
      } catch (e: any) { swDetail = 'Failed: ' + String(e?.message || e).slice(0, 80); }
    }
    out.push({ id: 'sw', label: 'Service worker controlling the page', ok: swOk, detail: swDetail });

    // Manifest valid.
    let manifestOk = false; let manifestDetail = ''; let iconSrcs: string[] = [];
    try {
      const r = await fetch('/manifest.webmanifest', { cache: 'no-store' });
      if (!r.ok) manifestDetail = `Manifest request failed (HTTP ${r.status}).`;
      else {
        const m = await r.json();
        const hasName = !!(m.name || m.short_name);
        const displayOk = ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display);
        const icons = Array.isArray(m.icons) ? m.icons : [];
        const has192 = icons.some((i: any) => String(i.sizes || '').split(' ').includes('192x192') && (!i.purpose || /any/.test(i.purpose)));
        const has512 = icons.some((i: any) => String(i.sizes || '').split(' ').includes('512x512') && (!i.purpose || /any/.test(i.purpose)));
        iconSrcs = icons.map((i: any) => i.src).filter(Boolean);
        manifestOk = hasName && displayOk && has192 && has512;
        manifestDetail = manifestOk ? `OK (display: ${m.display})${m.related_applications ? ' · has related_applications!' : ''}`
          : [!hasName && 'no name', !displayOk && `display="${m.display}"`, !has192 && 'no 192 any-icon', !has512 && 'no 512 any-icon'].filter(Boolean).join(', ');
      }
    } catch (e: any) { manifestDetail = 'Parse failed: ' + String(e?.message || e).slice(0, 80); }
    out.push({ id: 'manifest', label: 'Valid web app manifest', ok: manifestOk, detail: manifestDetail });

    // Manifest reachable WITHOUT login — the make-or-break check for Android.
    // Chrome mints the installed app (a WebAPK) via Google's server, which
    // fetches the manifest with NO cookies. If our auth gate redirects that
    // anonymous request to /login, minting fails and Chrome falls back to a
    // plain shortcut that opens in a browser tab — even though every other
    // check above is green (the logged-in browser fetch succeeds). We replay
    // the anonymous fetch here so that failure is visible on-device.
    let anonOk = false; let anonDetail = '';
    try {
      const r = await fetch('/manifest.webmanifest', { cache: 'no-store', credentials: 'omit', redirect: 'follow' });
      const ct = r.headers.get('content-type') || '';
      if (r.redirected || /text\/html/i.test(ct)) {
        anonDetail = 'Redirected to login when fetched without a session — WebAPK minting will fail and you’ll get a shortcut, not the real app.';
      } else {
        const txt = await r.text();
        try { JSON.parse(txt); anonOk = true; anonDetail = 'Public — Google’s WebAPK server can read it.'; }
        catch { anonDetail = 'Returned non-JSON without a session (likely a login page) — WebAPK minting will fail.'; }
      }
    } catch (e: any) { anonDetail = 'Anonymous fetch failed: ' + String(e?.message || e).slice(0, 80); }
    out.push({ id: 'manifestPublic', label: 'Manifest public to the installer (no login)', ok: anonOk, detail: anonDetail });

    // Icons load.
    let iconsOk = false; let iconDetail = 'No icons.';
    if (iconSrcs.length) {
      const res = await Promise.all(iconSrcs.slice(0, 4).map((s) => loadImage(s)));
      iconsOk = res.every(Boolean);
      iconDetail = iconsOk ? `${res.length} icon(s) loaded.` : 'One or more icons failed to load.';
    }
    out.push({ id: 'icons', label: 'App icons load', ok: iconsOk, detail: iconDetail });

    const hasPrompt = !!(window.__bipEvent) || canPrompt;
    const hardReady = out.filter((c) => ['https', 'sw', 'manifest', 'manifestPublic', 'icons'].includes(c.id)).every((c) => c.ok === true);
    out.push({ id: 'prompt', label: 'Installable on this device', ok: isStandalone ? true : (hasPrompt || hardReady ? true : null),
      detail: isStandalone ? 'Already installed.' : hasPrompt ? 'Ready — tap Install above.'
        : hardReady ? 'All requirements pass ✓. If Install does nothing, Chrome suppressed the prompt — install from ⋮ menu → “Install app”.'
        : 'Waiting — fix the items above first.' });

    setChecks(out);
    if (window.__bipEvent) { deferredRef.current = window.__bipEvent; setCanPrompt(true); }

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
    const onInstalled = () => { setStandalone(true); setCanPrompt(false); setMsg('Installed! Find ResiWalk on your home screen.'); };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('bip-ready', onReady);
    window.addEventListener('appinstalled', onInstalled);
    void runChecks();
    const t = setTimeout(() => void runChecks(), 3500);
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
    // Android / desktop Chrome: fire the REAL install prompt.
    if (d) {
      try { d.prompt(); const { outcome } = await d.userChoice; setMsg(outcome === 'accepted' ? 'Installing… check your home screen.' : 'Dismissed — tap Install again any time.'); if (outcome === 'accepted') { deferredRef.current = null; (window as any).__bipEvent = null; setCanPrompt(false); } }
      catch { setMsg('Could not open the prompt.'); }
      return;
    }
    // iOS: no programmatic install exists — guide them through Add to Home Screen.
    if (br.current.isIOS) { setIosSheet(true); return; }
    setMsg('Chrome ⋮ menu → “Install app”. If it’s not there, the app may still be installed — uninstall it fully first.');
  };

  return (
    <div className="min-h-screen bg-gray-50 text-ink">
      <Head><title>Install ResiWalk</title><meta name="robots" content="noindex" /></Head>
      <div className="max-w-md mx-auto px-5 py-8">
        <div className="flex items-center gap-3 mb-5">
          {/* Logo → app home. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <a href="/app" aria-label="Go to home" title="Home"><img src="/icon-192.png" alt="ResiWalk" className="w-14 h-14 rounded-2xl shadow" /></a>
          <div>
            <h1 className="text-xl font-heading font-bold">Install ResiWalk</h1>
            <p className="text-sm text-gray-500">Add the app to your home screen — full-screen &amp; offline-ready.</p>
          </div>
        </div>

        {standalone ? (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 text-sm font-heading font-semibold">✓ You’re running the installed app — all set.</div>
        ) : (
          <>
            <button type="button" onClick={install}
              className="w-full py-3.5 rounded-xl bg-brand text-white text-base font-heading font-bold shadow active:bg-brand-dark">
              Install ResiWalk
            </button>
            <p className="text-xs text-gray-600 mt-2 leading-relaxed">{msg || (canPrompt ? 'Ready — tap Install.' : 'Tap Install; if nothing happens, check the readiness items below.')}</p>
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

          {Object.keys(det).length > 0 && (
            <details className="mt-4">
              <summary className="text-xs font-heading font-semibold text-gray-600 cursor-pointer">Technical details (screenshot &amp; send)</summary>
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

      {/* iOS Add-to-Home-Screen guide. iOS Safari exposes no install API, so this
          is the best possible iPhone experience: a one-tap guided sheet. */}
      {iosSheet && (
        <div className="fixed inset-0 z-[90] flex flex-col justify-end" role="dialog" aria-modal="true">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={() => setIosSheet(false)} />
          <div className="relative bg-white rounded-t-3xl shadow-2xl px-5 pt-5 pb-8 animate-[fadeIn_180ms_ease-out]">
            <div className="mx-auto w-10 h-1.5 rounded-full bg-gray-300 mb-4" />
            {br.current.isSafari ? (
              <>
                <h2 className="text-lg font-heading font-bold mb-1">Add ResiWalk to your Home Screen</h2>
                <p className="text-sm text-gray-500 mb-4">Two taps in Safari — then it opens full-screen like a real app.</p>
                <ol className="space-y-3">
                  <li className="flex items-center gap-3">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-brand text-white font-heading font-bold text-sm flex items-center justify-center">1</span>
                    <span className="text-[15px] text-ink flex items-center gap-1.5 flex-wrap">
                      Tap the <span className="inline-flex items-center gap-1 font-semibold text-brand">Share
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V3" /><path d="m8 7 4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></svg>
                      </span> button in Safari’s toolbar.
                    </span>
                  </li>
                  <li className="flex items-center gap-3">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-brand text-white font-heading font-bold text-sm flex items-center justify-center">2</span>
                    <span className="text-[15px] text-ink">Scroll down and tap <span className="font-semibold">“Add to Home Screen” <span className="inline-block align-middle border border-gray-400 rounded-[5px] px-1 text-gray-600 text-xs">＋</span></span></span>
                  </li>
                  <li className="flex items-center gap-3">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-brand text-white font-heading font-bold text-sm flex items-center justify-center">3</span>
                    <span className="text-[15px] text-ink">Tap <span className="font-semibold">Add</span> — done. Open ResiWalk from your home screen.</span>
                  </li>
                </ol>
                <p className="text-xs text-gray-400 mt-4 text-center">The Share button is at the bottom of the screen on iPhone, top on iPad.</p>
              </>
            ) : (
              <>
                <h2 className="text-lg font-heading font-bold mb-1">Open in Safari first</h2>
                <p className="text-[15px] text-gray-600 leading-relaxed">
                  On iPhone, “Add to Home Screen” only works in <strong>Safari</strong> — {br.current.name} can’t install apps.
                  Open <span className="font-semibold">resiwalk.com/install</span> in Safari, then tap <span className="font-semibold">Install ResiWalk</span> again.
                </p>
              </>
            )}
            <button type="button" onClick={() => setIosSheet(false)}
              className="w-full mt-6 py-3 rounded-xl bg-gray-100 text-gray-700 font-heading font-semibold">Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}
