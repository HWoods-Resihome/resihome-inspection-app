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
    // NOTE: we deliberately do NOT call screen.orientation.unlock() — in the
    // installed PWA / native shell it forced sensor rotation and overrode the
    // device's rotation-lock. The manifest's orientation:"any" already allows
    // rotation while RESPECTING the OS rotation lock, which is what we want.
    // Native-only OAuth bridge. No-op in browsers (checks
    // Capacitor.isNativePlatform() internally), so web behavior is unchanged —
    // this just enables the deep-link return inside the Capacitor app.
    void installOAuthBridge();
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
