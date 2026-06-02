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
        {/* Browser-tab (favicon) icon — the ResiWalk house mark. The SVG is a
            transparent, brand-pink house that fills the tab; PNGs are fallbacks
            for browsers that don't take SVG favicons. */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=2" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png?v=2" />
        <link rel="shortcut icon" href="/favicon.svg?v=2" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2" />
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
