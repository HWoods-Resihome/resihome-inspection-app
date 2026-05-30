import type { AppProps } from 'next/app';
import Head from 'next/head';
import { useEffect } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppDialogProvider } from '@/components/AppDialog';
import { installOAuthBridge } from '@/lib/nativeBridge';
import '../styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
  // Native-only OAuth bridge. installOAuthBridge() is a no-op in browsers
  // (it checks Capacitor.isNativePlatform() internally), so web behavior is
  // unchanged — this just enables the deep-link return inside the Capacitor app.
  useEffect(() => {
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
        <Component {...pageProps} />
      </AppDialogProvider>
    </ErrorBoundary>
  );
}
