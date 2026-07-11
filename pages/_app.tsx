import { useEffect } from 'react';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import Router from 'next/router';
import { SERVICES_FLAG_ON } from '@/lib/featureFlags';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppDialogProvider } from '@/components/AppDialog';
import { FlashProvider } from '@/components/Flash';
import { FieldStatusOverlays } from '@/components/FieldStatusOverlays';
import { PdfViewerHost } from '@/components/PdfViewerHost';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { initErrorReporting } from '@/lib/clientErrorReporter';
import { installSessionGuard } from '@/lib/sessionGuard';
import { registerServiceWorker } from '@/lib/useAppUpdate';
import { installOAuthBridge, installPushBridge, primeLocationPermissionNative, installNativeBackGuard } from '@/lib/nativeBridge';
import { initPushOnLoad } from '@/lib/pushClient';
import { installGlobalSync } from '@/lib/globalSync';
import { Raleway } from 'next/font/google';
import '../styles/globals.css';
import 'leaflet/dist/leaflet.css';   // Services calendar/map view (namespaced .leaflet-* — inert elsewhere)

// Self-hosted Raleway (was a render-blocking Google Fonts @import in globals.css).
// next/font downloads + inlines the font at build time and exposes it as the
// --font-raleway CSS variable, which Tailwind's `font-heading` resolves. Removes
// the runtime CDN round-trips on every cold load (better first paint + no CLS).
const raleway = Raleway({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-raleway',
  fallback: ['Arial', 'sans-serif'],
});

// Real-user Web Vitals (LCP / INP / CLS / FCP / TTFB) from actual field devices,
// beaconed to a lightweight sink. Next calls this automatically. Fire-and-forget
// — it must never affect the page.
export function reportWebVitals(metric: { name: string; value: number; id: string; rating?: string }): void {
  try {
    if (typeof navigator === 'undefined') return;
    const body = JSON.stringify({
      name: metric.name,
      // CLS is a unitless fractional score (~0–0.3); rounding it to an integer
      // collapses every acceptable value to 0. Keep 3 decimals for CLS; the
      // millisecond metrics (LCP/FCP/TTFB/INP) round to whole ms.
      value: metric.name === 'CLS' ? Math.round(metric.value * 1000) / 1000 : Math.round(metric.value),
      rating: metric.rating,
      url: typeof window !== 'undefined' ? window.location?.pathname : undefined,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/telemetry/vitals', new Blob([body], { type: 'application/json' }));
    } else {
      void fetch('/api/telemetry/vitals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* never throw */ }
}

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    // Field reliability: capture crashes/silent failures, catch session
    // expiry, and install the offline-shell service worker.
    initErrorReporting();
    installSessionGuard();
    registerServiceWorker();
    // NOTE: we deliberately do NOT call screen.orientation.unlock(), and the
    // manifest deliberately OMITS the `orientation` key. Both forced sensor
    // rotation in the installed PWA: manifest orientation:"any" maps to the
    // WebAPK's FULL_SENSOR, which rotates regardless of the device's auto-rotate
    // lock. With no orientation set (→ UNSPECIFIED) the app defers to the OS —
    // it rotates when auto-rotate is on and stays put when the user locks it.
    // Native-only OAuth bridge. No-op in browsers (checks
    // Capacitor.isNativePlatform() internally), so web behavior is unchanged —
    // this just enables the deep-link return inside the Capacitor app.
    void installOAuthBridge();
    // Approval alerts: prompt a signed-in inspector once to enable Web Push,
    // then keep their subscription fresh. No-op until VAPID env is configured
    // or on browsers without push support. (Native FCM is a separate path.)
    void initPushOnLoad();
    // Native-only: register the FCM/APNs device token in the Capacitor shell.
    // No-op in a browser (the PWA path above handles web push).
    void installPushBridge();
    // Native-only: ask for Location up front so evidence photos can be GPS-
    // stamped from the first capture. No-op on web/PWA. (Requires the native
    // build to declare the location usage string — see mobile/ runbooks.)
    primeLocationPermissionNative();
    // Native-only: make the Android back gesture close an open overlay, go HOME
    // from inside an inspection (clean history → back lands on the list), and
    // leave the app from the home screen. No-op on web/PWA. Works with the in-app
    // PDF viewer's / camera's history-backed close.
    installNativeBackGuard();
    // Global background sync (any page): drain queued answer/line/section edits
    // and nudge queued photo uploads, so offline work syncs the moment signal
    // returns — not only while an inspection form is open.
    installGlobalSync();
  }, []);

  // BULLETPROOF offline-readiness (independent of the SW install precache, which
  // depends on a build-generated manifest + gated fetches that can silently fail
  // on the deployed host). While ONLINE we:
  //   1) eagerly import the lazily-loaded inspection FORM chunks (RateCard /
  //      Question / QC) — webpack's own import() resolves the correct chunk hashes
  //      for THIS build and the fetch goes through the SW's stale-while-revalidate
  //      static caching, so the forms are cached for offline. This is the chunk
  //      that otherwise hangs on "Loading…" offline.
  //   2) cache the id-AGNOSTIC /inspection/[id] route shell HTML directly into the
  //      SW cache (a PAGE fetch carries the session cookie, so unlike the SW's own
  //      install fetch it can't be redirected to /login) so an OFFLINE hard-nav /
  //      reload to /inspection/<id> renders the app instead of bouncing to home.
  // Runs a few seconds after load (SW is controlling by then) and again on
  // reconnect. No build-manifest, no gated SW fetch — it can't silently no-op.
  useEffect(() => {
    const warm = async () => {
      if (typeof navigator === 'undefined' || navigator.onLine === false) return;
      try {
        await Promise.all([
          import('@/components/RateCardForm'),
          import('@/components/QuestionForm'),
          import('@/components/QcReinspectForm'),
        ]);
      } catch { /* best-effort — a failed warm just retries on reconnect */ }
      try {
        if (typeof caches === 'undefined') return;
        const version = process.env.NEXT_PUBLIC_APP_VERSION || 'v3';
        const cache = await caches.open('resiwalk-shell-' + version);
        const r = await fetch('/inspection/_precache_shell_', { cache: 'no-store' });
        if (r && r.ok) await cache.put('/inspection/__id_shell__', r.clone());
      } catch { /* no Cache API / offline — fine */ }
    };
    const t = setTimeout(() => { void warm(); }, 4000);
    const onOnline = () => { void warm(); };
    window.addEventListener('online', onOnline);
    return () => { clearTimeout(t); window.removeEventListener('online', onOnline); };
  }, []);

  // On the Services preview only (SERVICES_FLAG_ON is off in production), stamp the
  // browser tab as "ResiWalk - Services" so it's obvious at a glance which
  // deployment a tab is — the preview points at PROD HubSpot, so telling it apart
  // from the real app matters. Re-applied after every route change because
  // individual pages set their own <title> (e.g. the home page → "ResiWalk"),
  // which would otherwise overwrite it on navigation. Inert on resiwalk.com.
  useEffect(() => {
    if (!SERVICES_FLAG_ON) return;
    const apply = () => { document.title = 'ResiWalk - Services'; };
    apply();
    // rAF wins any late <title> commit from the newly-rendered page's <Head>.
    const applySoon = () => { apply(); requestAnimationFrame(apply); };
    Router.events.on('routeChangeComplete', applySoon);
    return () => { Router.events.off('routeChangeComplete', applySoon); };
  }, []);

  return (
    <ErrorBoundary>
      <Head>
        {/* Single global viewport. No maximum-scale so pinch-zoom works
            (accessibility). Individual pages no longer set their own.
            viewport-fit=cover makes iOS expose env(safe-area-inset-*) so
            full-screen UI (the camera) can pad around the notch / home
            indicator / Safari toolbar instead of hiding controls under them. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      {/* `display:contents` so this wrapper exposes --font-raleway to the whole
          tree without introducing a layout box (full-height page layouts are
          unaffected). */}
      <div className={raleway.variable} style={{ display: 'contents' }}>
        <AppDialogProvider>
          <FlashProvider>
            <FieldStatusOverlays />
            <ImpersonationBanner />
            <Component {...pageProps} />
            <SyncStatusBadge />
            <PdfViewerHost />
          </FlashProvider>
        </AppDialogProvider>
      </div>
    </ErrorBoundary>
  );
}
