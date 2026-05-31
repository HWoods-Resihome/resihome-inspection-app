/** @type {import('next').NextConfig} */
const pkg = require('./package.json');

const nextConfig = {
  reactStrictMode: true,
  env: {
    // Baked at build time so the running client knows which version it is, and
    // can detect when a newer one has been deployed (see lib/useAppUpdate.ts).
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

module.exports = nextConfig;
