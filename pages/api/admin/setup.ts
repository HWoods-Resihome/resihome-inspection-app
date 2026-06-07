/**
 * /api/admin/setup   (app-admin only)
 *
 *   POST -> create the HubSpot properties the new admin features need
 *           (app_admins_json, app_templates_json, is_enabled). Idempotent.
 *
 * Replaces the Python setup scripts for anyone without a local env: the app
 * provisions the schema with its own HubSpot token. Run from /admin/setup.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { provisionAppProperties } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const results = await provisionAppProperties();
    const ok = Object.values(results).every((v) => v === 'exists' || v === 'created');
    return res.status(200).json({ ok, results });
  } catch (e: any) {
    console.error('[admin/setup] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
