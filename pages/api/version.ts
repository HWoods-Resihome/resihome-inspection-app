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
  res.status(200).json({ version: (pkg as { version: string }).version });
}
