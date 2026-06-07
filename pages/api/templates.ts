/**
 * GET /api/templates  (any authenticated internal user)
 *
 * Returns the admin-created CUSTOM templates so the New-Inspection picker can
 * offer them alongside the built-in templates (which the picker hardcodes).
 * External (1099) users get none — they're locked to their own template.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isExternalEmail } from '@/lib/userAccess';
import { getCustomTemplates } from '@/lib/formTemplates';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (isExternalEmail(session.email)) return res.status(200).json({ templates: [] });

  try {
    const custom = await getCustomTemplates();
    return res.status(200).json({ templates: custom.map((t) => ({ id: t.id, label: t.label })) });
  } catch (e: any) {
    console.error('[templates] failed:', e);
    return res.status(200).json({ templates: [] }); // never block inspection creation
  }
}
