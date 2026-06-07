/**
 * /api/admin/templates   (app-admin only)
 *
 *   GET  -> { templates }   editable templates (built-in question-driven + custom)
 *   POST { label } -> { ok, template }   create a custom template
 *
 * Custom templates are question-driven and appear in the form builder + the
 * New-Inspection picker. Scope/QC are never here. See lib/formTemplates.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { getEditableTemplates, addCustomTemplate } from '@/lib/formTemplates';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ templates: await getEditableTemplates() });
    }
    if (req.method === 'POST') {
      const label = String((req.body || {}).label || '').trim();
      if (!label) return res.status(400).json({ error: 'Template name is required.' });
      const template = await addCustomTemplate(label, session.email);
      return res.status(200).json({ ok: true, template, templates: await getEditableTemplates() });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error('[admin/templates] failed:', e);
    return res.status(400).json({ error: String(e?.message || e).slice(0, 280) });
  }
}
