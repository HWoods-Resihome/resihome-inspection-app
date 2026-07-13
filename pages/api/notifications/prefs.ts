/**
 * GET  /api/notifications/prefs → the logged-in user's notification toggles +
 *      which objects they can access (inspections / services) + admin flag.
 * POST /api/notifications/prefs { prefs: { [key]: boolean } } → save the user's
 *      own toggles. Any logged-in user (this is personal settings, not admin).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { NOTIFICATION_KEYS, type NotificationKey } from '@/lib/notifications/catalog';
import { getNotificationPrefs, setNotificationPrefs } from '@/lib/notifications/prefs';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  if (!email) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method === 'GET') {
    const [prefs, services, admin] = await Promise.all([
      getNotificationPrefs(email),
      servicesEnabled(email).catch(() => false),
      isAppAdmin(email).catch(() => false),
    ]);
    // Every authenticated user can access inspections; services is gated.
    return res.status(200).json({ prefs, access: { inspections: true, services }, isAdmin: admin, email });
  }

  if (req.method === 'POST') {
    const body = (req.body || {}) as { prefs?: Record<string, unknown> };
    const incoming = body.prefs || {};
    const clean: Partial<Record<NotificationKey, boolean>> = {};
    for (const k of NOTIFICATION_KEYS) if (typeof incoming[k] === 'boolean') clean[k] = incoming[k] as boolean;
    if (!Object.keys(clean).length) return res.status(400).json({ error: 'No valid preferences supplied.' });
    const ok = await setNotificationPrefs(email, clean);
    if (!ok) return res.status(200).json({ ok: true, preview: true });   // store not configured
    return res.status(200).json({ ok: true, prefs: await getNotificationPrefs(email) });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
