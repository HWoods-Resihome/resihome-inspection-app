import type { AppProps } from 'next/app';
import Head from 'next/head';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AppDialogProvider } from '@/components/AppDialog';
import '../styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
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
