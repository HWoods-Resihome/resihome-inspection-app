/**
 * PATCH /api/admin/inspections/[id]/template   (app-admin only)
 *   { templateType }  -> change which form an inspection uses.
 *
 * Reassignment is allowed ONLY among editable (question-driven) templates — you
 * can't move an inspection to/from Scope Rate Card or Turn Re-Inspect QC, whose
 * data models differ. Existing answers are keyed by question, so they survive
 * (answers for questions not in the new form are simply not shown). Audit-logged.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspectionById, updateInspection } from '@/lib/hubspot';
import { isProtectedTemplate } from '@/lib/formBuilder';
import { isEditableTemplateAsync } from '@/lib/formTemplates';
import { recordAuditEvent } from '@/lib/auditLog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing inspection id' });
  const target = String((req.body || {}).templateType || '').trim();
  if (!target) return res.status(400).json({ error: 'templateType is required.' });

  try {
    const inspection = await fetchInspectionById(id);
    if (!inspection) return res.status(404).json({ error: 'Inspection not found.' });
    const current = String(inspection.templateType || '');

    if (isProtectedTemplate(current)) return res.status(403).json({ error: 'Scope and QC inspections can’t be reassigned here.' });
    if (isProtectedTemplate(target)) return res.status(403).json({ error: 'Can’t reassign to a locked (Scope/QC) template.' });
    if (!(await isEditableTemplateAsync(target))) return res.status(400).json({ error: 'Unknown or non-editable target template.' });
    if (current === target) return res.status(200).json({ ok: true, unchanged: true });

    await updateInspection(id, { template_type: target });
    void recordAuditEvent({
      inspectionId: id, action: 'reassign', actorEmail: session.email, actorName: session.name,
      detail: `Form changed from ${current || '(none)'} to ${target}`,
      meta: { from: current, to: target },
    });
    return res.status(200).json({ ok: true, from: current, to: target });
  } catch (e: any) {
    console.error(`[admin/inspections/${id}/template] failed:`, e);
    return res.status(400).json({ error: String(e?.message || e).slice(0, 280) });
  }
}
