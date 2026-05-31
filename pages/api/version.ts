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
  // Must mirror NEXT_PUBLIC_APP_VERSION in next.config.js: the live deployment's
  // git SHA (so each deploy is a new version), falling back to package.json.
  const version = (process.env.VERCEL_GIT_COMMIT_SHA || (pkg as { version: string }).version).slice(0, 7);
  res.status(200).json({ version });
}
