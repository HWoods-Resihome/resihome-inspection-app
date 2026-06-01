import { useEffect } from 'react';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppDialogProvider } from '@/components/AppDialog';
import { FieldStatusOverlays } from '@/components/FieldStatusOverlays';
import { initErrorReporting } from '@/lib/clientErrorReporter';
import { installSessionGuard } from '@/lib/sessionGuard';
import { registerServiceWorker } from '@/lib/useAppUpdate';
import { installOAuthBridge } from '@/lib/nativeBridge';
import '../styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    // Field reliability: capture crashes/silent failures, catch session
    // expiry, and install the offline-shell service worker.
    initErrorReporting();
    installSessionGuard();
    registerServiceWorker();
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
      <AppDialogProvider>
        <FieldStatusOverlays />
        <Component {...pageProps} />
      </AppDialogProvider>
    </ErrorBoundary>
  );
}
