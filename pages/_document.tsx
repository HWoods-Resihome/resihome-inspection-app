import { Html, Head, Main, NextScript } from 'next/document';

// Document-level <head>. The viewport meta lives in _app.tsx (once, globally).
export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* PWA: installable to the home screen + branded chrome. The service
            worker (registered in _app) provides the offline shell. */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#ff0060" />
        {/* Browser-tab (favicon) icon — the ResiWalk house logo instead of the
            default globe. */}
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
        <link rel="shortcut icon" href="/icon-192.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="ResiWalk" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
