/** @type {import('next').NextConfig} */
const pkg = require('./package.json');

const nextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework (tiny hardening; removes the X-Powered-By header).
  poweredByHeader: false,
  // Don't ship source maps to the browser in production — smaller deploy, and the
  // app's own error reporter already captures what we need server-side.
  productionBrowserSourceMaps: false,
  experimental: {
    // Keep the headless-browser packages external (not webpack-bundled) so
    // @sparticuz/chromium resolves its binary correctly. Used by
    // lib/ticketUpload.ts (PDF upload into tickets).
    serverComponentsExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
    // Force the chromium payload (chromium.br + the al2/al2023 lib tarballs that
    // hold libnss3 etc.) into the upload function's deployment — otherwise the
    // browser launches but can't find its shared libraries.
    outputFileTracingIncludes: {
      '/api/inspections/[id]/create-maintenance-ticket': [
        './node_modules/@sparticuz/chromium/bin/**',
      ],
    },
  },
  env: {
    // Baked at build time so the running client knows which version it is, and
    // can detect when a newer one has been deployed (see lib/useAppUpdate.ts).
    // Prefer the Vercel git commit SHA (changes every deploy) so the
    // "new version available" prompt fires on each release without having to
    // hand-bump package.json. Falls back to package.json for local dev. Short
    // SHA keeps the login footer readable.
    NEXT_PUBLIC_APP_VERSION: (process.env.VERCEL_GIT_COMMIT_SHA || pkg.version).slice(0, 7),
  },
  async headers() {
    return [
      {
        // Serve the PWA manifest with the correct content-type so Android Chrome
        // reliably parses it for installability (some hosts default .webmanifest
        // to text/plain, which can trip the install check).
        source: '/manifest.webmanifest',
        headers: [{ key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' }],
      },
      {
        // The service worker must be served from the root scope and never cached
        // stale, so a new SW is picked up promptly.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
