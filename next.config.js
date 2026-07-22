/** @type {import('next').NextConfig} */
const pkg = require('./package.json');

// Vercel Blob public host, e.g. "7imh0yfpshxqifte.public.blob.vercel-storage.com".
// When set, stored files are served under OUR domain via a transparent /m/* rewrite
// (so the address bar shows resiwalk.com and the tab shows the ResiWalk favicon,
// never "blob.vercel-storage.com"). Prefer the explicit BLOB_PUBLIC_HOST env; else
// best-effort derive it from the store id embedded in BLOB_READ_WRITE_TOKEN
// (vercel_blob_rw_<storeId>_<secret>). Empty → the rewrite is NOT added and file
// URLs stay exactly as today (zero behavior change until configured).
function resolveBlobHost() {
  const explicit = (process.env.BLOB_PUBLIC_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (explicit) return explicit;
  const tok = (process.env.BLOB_READ_WRITE_TOKEN || '').trim();
  const m = /^vercel_blob_rw_([a-z0-9]+)_/i.exec(tok);
  return m ? `${m[1].toLowerCase()}.public.blob.vercel-storage.com` : '';
}
const BLOB_PUBLIC_HOST = resolveBlobHost();

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
    // pdfjs-dist is kept external (not webpack-bundled) so the maint-ticket
    // backfill can text-extract completed PDFs server-side — bundling mangles its
    // dynamic worker/canvas requires and it throws at runtime on Vercel.
    serverComponentsExternalPackages: ['@sparticuz/chromium', 'puppeteer-core', 'ffmpeg-static', 'pdfjs-dist'],
    // Force the chromium payload (chromium.br + the al2/al2023 lib tarballs that
    // hold libnss3 etc.) into the upload function's deployment — otherwise the
    // browser launches but can't find its shared libraries. Likewise force the
    // ffmpeg-static binary into the two routes that faststart-remux mp4 clips so
    // iOS can play them (nft doesn't reliably trace the binary on its own).
    outputFileTracingIncludes: {
      '/api/inspections/[id]/create-maintenance-ticket': [
        './node_modules/@sparticuz/chromium/bin/**',
      ],
      '/api/admin/backfill-maint-ticket-answers': ['./node_modules/pdfjs-dist/legacy/build/**'],
      '/api/upload': ['./node_modules/ffmpeg-static/ffmpeg'],
      '/api/video-proxy': ['./node_modules/ffmpeg-static/ffmpeg'],
      '/api/video-transcode': ['./node_modules/ffmpeg-static/ffmpeg'],
      '/api/admin/ffmpeg-check': ['./node_modules/ffmpeg-static/ffmpeg'],
      // The committed training-guide HTML, force-included so the connector can
      // read it at runtime and push it into HubSpot Files.
      '/api/cron/training-guide-sync': ['./content/training/ResiWalk_Training_Guide.html'],
      '/api/admin/training-guide/deploy': ['./content/training/ResiWalk_Training_Guide.html'],
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
    // "1" only when a blob host is resolvable → the client rewrites raw blob URLs
    // to the branded same-origin /m/* path. Empty → display code leaves URLs as-is.
    NEXT_PUBLIC_BLOB_PROXY: BLOB_PUBLIC_HOST ? '1' : '',
  },
  // Transparent same-origin passthrough for stored files: /m/<key> proxies to the
  // Vercel Blob store, so the browser stays on our domain (branded URL + favicon).
  // Only added when the store host is known; otherwise a no-op.
  async rewrites() {
    if (!BLOB_PUBLIC_HOST) return [];
    return [{ source: '/m/:path*', destination: `https://${BLOB_PUBLIC_HOST}/:path*` }];
  },
  async headers() {
    // Content-Security-Policy — the primary XSS defense. script-src is locked to
    // 'self' + the ONE known inline script (the PWA install-prompt capture in
    // _document.tsx, allowed by its sha256 hash); every Next.js script is an
    // external 'self' chunk and __NEXT_DATA__ is non-executable JSON, so any
    // INJECTED inline/remote script is blocked. style 'unsafe-inline' is required
    // (next/font + React inline styles) but style injection is far less dangerous
    // than script. img/media allow https + data/blob for camera previews and
    // uploaded photos (Vercel Blob / HubSpot). connect allows https for uploads/
    // telemetry; with scripts locked down there's no injected code to abuse it.
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "form-action 'self'",
      "script-src 'self' 'sha256-/dzuVKxm5M81HPQdkEs7Ve8QU2pWS3+IIZNtCN40Nns='",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-src 'self' blob:",
      'upgrade-insecure-requests',
    ].join('; ');

    const securityHeaders = [
      { key: 'Content-Security-Policy', value: csp },
      // Force HTTPS for a year (Vercel + the PWA are HTTPS-only). Blocks SSL-strip
      // / downgrade MITM that could otherwise steal the session on first request.
      { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      // Stop MIME-sniffing (e.g. a user-uploaded file being run as a script).
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      // Clickjacking: no foreign site may frame the app (CSP frame-ancestors is
      // the modern equivalent; this covers older browsers).
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      // Don't leak full URLs (which can carry record IDs) to third parties.
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      // Powerful features: ALLOW the ones the inspection flow needs for this
      // origin (camera / mic / GPS), and deny the rest outright.
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), bluetooth=(), serial=(), browsing-topics=()' },
      // Isolate our browsing context from cross-origin window references (allow
      // popups for any future OAuth popup; the current flow is full-page).
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
      // No Adobe cross-domain policy files.
      { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
    ];

    return [
      {
        // Apply the security headers to every route.
        source: '/:path*',
        headers: securityHeaders,
      },
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
