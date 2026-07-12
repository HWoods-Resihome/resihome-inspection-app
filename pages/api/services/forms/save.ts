/**
 * POST /api/services/forms/save — persist the Service Form Builder (all forms,
 * keyed by `worktype:subtype`). Admin-gated. Body: { forms: Record<string, Question[]> }.
 * Stored as JSON on the admin Agent record; read live by the completion screen + PDF.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { writeServiceForms } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const forms = (req.body || {}).forms;
  if (!forms || typeof forms !== 'object') return res.status(400).json({ error: 'forms object required' });
  try {
    const okw = await writeServiceForms(forms);
    return res.status(200).json({ ok: okw, preview: !okw });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
