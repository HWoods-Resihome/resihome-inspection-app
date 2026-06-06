import Head from 'next/head';
import { useCallback, useEffect, useRef, useState } from 'react';

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
        await navigator.serviceWorker.register('/sw.js');
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
    if (!d) { setMsg(br.current.isIOS ? 'On iPhone: Share → Add to Home Screen.' : 'Chrome ⋮ menu → “Install app”. If it’s not there, the app may still be installed — uninstall it fully first.'); return; }
    try { d.prompt(); const { outcome } = await d.userChoice; setMsg(outcome === 'accepted' ? 'Installing… check your home screen.' : 'Dismissed — tap Install again any time.'); if (outcome === 'accepted') { deferredRef.current = null; (window as any).__bipEvent = null; setCanPrompt(false); } }
    catch { setMsg('Could not open the prompt.'); }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-ink">
      <Head><title>Install ResiWalk</title><meta name="robots" content="noindex" /></Head>
      <div className="max-w-md mx-auto px-5 py-8">
        <div className="flex items-center gap-3 mb-5">
          {/* Logo → app home. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <a href="/" aria-label="Go to home" title="Home"><img src="/icon-192.png" alt="ResiWalk" className="w-14 h-14 rounded-2xl shadow" /></a>
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
            <details className="mt-4" open>
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
    </div>
  );
}
