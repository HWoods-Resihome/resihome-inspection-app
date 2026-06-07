/**
 * /api/admin/admins/[email]   (app-admin only)
 *
 *   DELETE -> { ok }   remove an admin from the dynamic list.
 *
 * Seed (built-in) admins cannot be removed. See lib/adminAccess.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin, removeAdmin, listAdmins } from '@/lib/adminAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = req.query.email;
  const email = decodeURIComponent(Array.isArray(raw) ? raw[0] : (raw || ''));
  if (!email) return res.status(400).json({ error: 'Missing email' });

  try {
    await removeAdmin(email);
    return res.status(200).json({ ok: true, admins: await listAdmins() });
  } catch (e: any) {
    console.error(`[admins] delete ${email} failed:`, e);
    return res.status(400).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
