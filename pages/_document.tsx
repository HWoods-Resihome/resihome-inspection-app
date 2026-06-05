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
        {/* Browser-tab (favicon) icon — the ResiWALK house + footprint mark in
            brand pink on a TRANSPARENT background. The SVG is what modern browsers
            use; the favicon-*.png are transparent PNG fallbacks for the rare
            browser that can't render an SVG favicon. (The solid-pink-tile
            icon-192/icon-512/apple-touch icons are the installed-app + home-screen
            icons — those keep a background on purpose; transparency renders black
            on iOS and breaks the maskable safe-zone.) */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=5" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=5" />
        <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png?v=5" />
        <link rel="icon" type="image/png" sizes="512x512" href="/favicon-512.png?v=5" />
        <link rel="shortcut icon" href="/favicon.svg?v=5" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=3" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="ResiWalk" />
        {/* Capture Chrome's install event AS EARLY AS POSSIBLE — it can fire
            before React hydrates, in which case a listener added later misses it
            and the in-app Install banner never shows. We stash it on window and
            notify the InstallPrompt component (which reads it on mount). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__bipEvent=e;try{window.dispatchEvent(new Event('bip-ready'))}catch(_){}});" +
              "window.addEventListener('appinstalled',function(){window.__bipEvent=null;});",
          }}
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
