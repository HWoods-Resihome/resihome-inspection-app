/** @type {import('next').NextConfig} */
const pkg = require('./package.json');

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Keep the headless-browser packages external (not webpack-bundled) so
    // @sparticuz/chromium resolves its binary correctly and Vercel traces it
    // into the function. Used by lib/ticketUpload.ts (PDF upload into tickets).
    serverComponentsExternalPackages: ['@sparticuz/chromium', 'puppeteer-core'],
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
};

module.exports = nextConfig;
