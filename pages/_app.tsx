import { useEffect } from 'react';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppDialogProvider } from '@/components/AppDialog';
import { FlashProvider } from '@/components/Flash';
import { FieldStatusOverlays } from '@/components/FieldStatusOverlays';
import { PdfViewerHost } from '@/components/PdfViewerHost';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import { initErrorReporting } from '@/lib/clientErrorReporter';
import { installSessionGuard } from '@/lib/sessionGuard';
import { registerServiceWorker } from '@/lib/useAppUpdate';
import { installOAuthBridge, installPushBridge, primeLocationPermissionNative, installNativeBackGuard } from '@/lib/nativeBridge';
import { initPushOnLoad } from '@/lib/pushClient';
import { installGlobalSync } from '@/lib/globalSync';
import { Raleway } from 'next/font/google';
import '../styles/globals.css';

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
            <PdfViewerHost />
          </FlashProvider>
        </AppDialogProvider>
      </div>
    </ErrorBoundary>
  );
}
