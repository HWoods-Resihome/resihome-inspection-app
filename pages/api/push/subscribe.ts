import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { savePushTarget } from '@/lib/pushSubscriptions';

/**
 * POST /api/push/subscribe
 *
 * Register a push target for the signed-in user so they can be notified (e.g.
 * when their submitted inspection is approved). Accepts either:
 *   - Web Push:  { subscription: <PushSubscriptionJSON> }     (platform 'web')
 *   - Native:    { token: '<fcm-token>', platform: 'native' } (Capacitor/FCM)
 *
 * Idempotent — re-subscribing the same device overwrites its record.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const platform = body.platform === 'native' ? 'native' : 'web';
    const ok = await savePushTarget({
      platform,
      userEmail: session.email,
      subscription: platform === 'web' ? body.subscription : undefined,
      token: platform === 'native' ? body.token : undefined,
      userAgent: (req.headers['user-agent'] as string) || undefined,
    });
    if (!ok) return res.status(400).json({ error: 'Could not store subscription (missing data or storage not configured).' });
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[push/subscribe] failed:', e);
    return res.status(400).json({ error: 'Bad subscription payload.' });
  }
}
