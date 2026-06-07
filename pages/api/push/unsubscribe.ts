import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { removePushTarget } from '@/lib/pushSubscriptions';

/**
 * POST /api/push/unsubscribe
 *
 * Remove a push target for the signed-in user (they turned alerts off, or the
 * browser rotated/expired the subscription). Body: { endpoint } for Web Push,
 * or { token } for a native target.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    await removePushTarget(session.email, { endpoint: body.endpoint, token: body.token });
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[push/unsubscribe] failed:', e);
    return res.status(200).json({ ok: true }); // unsubscribe is best-effort
  }
}
