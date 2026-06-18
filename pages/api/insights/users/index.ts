/**
 * /api/insights/users   (app-admin only)
 *
 *   GET  -> { users }   the Insights-Only roster
 *   POST -> { ok, users }   add an Insights-Only user   body: { email }
 *
 * Insights-Only users can view the /insights dashboards but have NO admin
 * capabilities. Admins are managed separately (/api/admin/admins) and already
 * have insights access via canViewInsights — they don't belong on this list.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { listInsightsUsers, addInsightsUser } from '@/lib/insightsAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ users: await listInsightsUsers() });
    }
    if (req.method === 'POST') {
      const email = String((req.body || {}).email || '').trim();
      if (!email) return res.status(400).json({ error: 'Email is required.' });
      await addInsightsUser(email, session.email);
      return res.status(200).json({ ok: true, users: await listInsightsUsers() });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error('[insights-users] failed:', e);
    return res.status(400).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
