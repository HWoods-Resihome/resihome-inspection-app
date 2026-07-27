/**
 * GET /api/properties/[id]/activity — admin-only. The recent inspections + recent
 * services for one property, for the admin Properties page's expandable card (and
 * its lazy last-activity summary chips). Both lists newest-first; lean fields only.
 *
 * Returns { inspections: InspRow[], services: SvcRow[] }.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspectionsForProperty, fetchServicesForProperty } from '@/lib/hubspot';
import { templateLabel } from '@/lib/templateLabels';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admins only' });
  }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const id = String(req.query.id || '').trim();
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid property id' });

  try {
    const [insp, svcs] = await Promise.all([
      fetchInspectionsForProperty(id).catch(() => []),
      fetchServicesForProperty(id).catch(() => []),
    ]);

    const inspections = insp.map((i) => ({
      id: i.recordId,
      label: templateLabel(i.templateType) || i.templateType || 'Inspection',
      status: i.status || '',
      // Best available "when": completed → submitted → started → scheduled → created.
      date: i.completedAt || i.submittedAt || i.startedAt || i.scheduledDate || i.createdAt || null,
      inspectorName: i.inspectorName || '',
    }));

    const services = svcs.map((s) => ({
      id: s.id,
      label: `${worktypeLabel(s.worktype)}${s.subtype ? ` · ${subtypeLabel(s.worktype, s.subtype)}` : ''}`,
      status: s.status || '',
      isGrassCut: s.worktype === 'landscaping' && s.subtype === 'cut',
      completedAt: s.completedAt || null,
      dueDate: s.dueDate || null,
      vendor: s.vendor || '',
      // Sort/display "when": completed → last-updated → estimated (bid) date.
      date: s.completedAt || s.updatedAt || s.estimatedAt || null,
    }));

    return res.status(200).json({ inspections, services });
  } catch (e: any) {
    console.error(`GET /api/properties/${id}/activity failed:`, e?.message, e?.detail);
    return res.status(500).json({ error: String(e?.message || e), detail: e?.detail || null });
  }
}
