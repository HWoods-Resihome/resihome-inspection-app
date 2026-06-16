import type { NextApiRequest, NextApiResponse } from 'next';
import pkg from '../../package.json';

/**
 * Reports the currently-deployed app version. The client compares this against
 * the version it booted with (NEXT_PUBLIC_APP_VERSION) to detect a new deploy
 * and prompt the inspector to reload — so field devices don't run a stale
 * build for days. No auth needed; it leaks nothing sensitive.
 */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  // Return the EXACT value the client booted with (NEXT_PUBLIC_APP_VERSION, baked
  // into the build by next.config.js). The client compares this against its own
  // NEXT_PUBLIC_APP_VERSION, so they MUST come from the same source. The old code
  // re-derived from VERCEL_GIT_COMMIT_SHA at REQUEST time — but that system var
  // isn't guaranteed in the serverless runtime, so it fell back to package.json's
  // version while the client had booted with the git SHA. They never matched, so
  // the "reload to update" banner showed forever and no amount of reloading
  // cleared it. Sourcing both from NEXT_PUBLIC_APP_VERSION makes them agree for a
  // given deploy, and differ (correctly) only when a genuinely new build is live.
  const version = (
    process.env.NEXT_PUBLIC_APP_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    (pkg as { version: string }).version ||
    'dev'
  ).slice(0, 7);
  res.status(200).json({ version });
}
