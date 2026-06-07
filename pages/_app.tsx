import { useEffect } from 'react';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppDialogProvider } from '@/components/AppDialog';
import { FlashProvider } from '@/components/Flash';
import { FieldStatusOverlays } from '@/components/FieldStatusOverlays';
import { initErrorReporting } from '@/lib/clientErrorReporter';
import { installSessionGuard } from '@/lib/sessionGuard';
import { registerServiceWorker } from '@/lib/useAppUpdate';
import { installOAuthBridge } from '@/lib/nativeBridge';
import { initPushOnLoad } from '@/lib/pushClient';
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
  }, []);

  return (
    <ErrorBoundary>
      <Head>
        {/* Single global viewport. No maximum-scale so pinch-zoom works
            (accessibility). Individual pages no longer set their own. */}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      {/* `display:contents` so this wrapper exposes --font-raleway to the whole
          tree without introducing a layout box (full-height page layouts are
          unaffected). */}
      <div className={raleway.variable} style={{ display: 'contents' }}>
        <AppDialogProvider>
          <FlashProvider>
            <FieldStatusOverlays />
            <Component {...pageProps} />
          </FlashProvider>
        </AppDialogProvider>
      </div>
    </ErrorBoundary>
  );
}
