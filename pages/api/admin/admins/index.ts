/**
 * /api/admin/admins   (app-admin only)
 *
 *   GET  -> { admins }   the full roster (seed + dynamic)
 *   POST -> { ok }       add an admin to the dynamic list   body: { email }
 *
 * App-admin grants AI Knowledge curation, the form builder, and admin
 * management. Seed admins are permanent. See lib/adminAccess.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin, listAdmins, addAdmin } from '@/lib/adminAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ admins: await listAdmins() });
    }
    if (req.method === 'POST') {
      const email = String((req.body || {}).email || '').trim();
      if (!email) return res.status(400).json({ error: 'Email is required.' });
      await addAdmin(email, session.email);
      return res.status(200).json({ ok: true, admins: await listAdmins() });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error('[admins] failed:', e);
    return res.status(400).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
