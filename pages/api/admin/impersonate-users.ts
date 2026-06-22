/**
 * GET /api/admin/impersonate-users — distinct inspectors (email + name) seen
 * across inspections, for the admin "view as" picker. App-admin only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });

  try {
    const all = await fetchInspections();
    const byEmail = new Map<string, string>(); // lowercased email → display name
    for (const i of all) {
      const email = (i.inspectorEmail || '').trim();
      if (!email || !email.includes('@')) continue;
      const key = email.toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, i.inspectorName || email);
    }
    const users = Array.from(byEmail.entries())
      .map(([email, name]) => ({ email, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return res.status(200).json({ users });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
