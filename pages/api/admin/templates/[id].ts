/**
 * /api/admin/templates/[id]   (app-admin only)
 *
 *   DELETE -> remove a CUSTOM template. Built-in templates can't be removed.
 *
 * Removing a custom template hides it from the picker/builder; its questions are
 * left in HubSpot (archive them in the builder first if you want them gone).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { removeCustomTemplate, getEditableTemplates } from '@/lib/formTemplates';
import { EDITABLE_TEMPLATES, isProtectedTemplate } from '@/lib/formBuilder';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing template id' });
  if (isProtectedTemplate(id) || EDITABLE_TEMPLATES.some((e) => e.id === id)) {
    return res.status(403).json({ error: 'Built-in templates can’t be removed.' });
  }

  try {
    await removeCustomTemplate(id);
    return res.status(200).json({ ok: true, templates: await getEditableTemplates() });
  } catch (e: any) {
    console.error(`[admin/templates] delete ${id} failed:`, e);
    return res.status(400).json({ error: String(e?.message || e).slice(0, 280) });
  }
}
