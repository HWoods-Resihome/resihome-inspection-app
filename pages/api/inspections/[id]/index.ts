import type { NextApiRequest, NextApiResponse } from 'next';
import {
  fetchInspectionWithPropertyRef,
  fetchAnswersForInspection,
  fetchInspectionById,
  updateInspection,
} from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  if (req.method === 'GET') {
    try {
      const data = await fetchInspectionWithPropertyRef(id);
      if (!data) return res.status(404).json({ error: 'Inspection not found' });
      const answers = await fetchAnswersForInspection(id);
      return res.status(200).json({
        inspection: data.inspection,
        propertyRecordId: data.propertyIdRef,
        propertySquareFootage: data.propertySquareFootage,
        propertyZip: data.propertyZip,
        propertyLastTenantMonths: data.propertyLastTenantMonths,
        answers,
      });
    } catch (e: any) {
      console.error(`GET /api/inspections/${id} failed:`, e);
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const props = req.body?.properties || req.body || {};
      if (!props || typeof props !== 'object') {
        return res.status(400).json({ error: 'Missing properties' });
      }
      // Allowlist: this general PATCH endpoint may only set fields the client is
      // expected to send here (currently the section layout). Status/verdict and
      // other lifecycle fields have dedicated, guarded routes — don't let an
      // arbitrary property write through this surface.
      const ALLOWED_PATCH_FIELDS = new Set(['section_list_json']);
      const filtered: Record<string, any> = {};
      for (const k of Object.keys(props)) {
        if (ALLOWED_PATCH_FIELDS.has(k)) filtered[k] = props[k];
      }
      if (Object.keys(filtered).length === 0) {
        return res.status(400).json({ error: 'No editable properties in request' });
      }
      // Compare-and-swap for the section layout: if the client tells us the
      // value it believes is current (baseSectionListJson) and that no longer
      // matches what's stored, another tab/device changed it first — reject so
      // we don't clobber their edit (last-writer-wins data loss). The client
      // reloads on 409. Only enforced when the client opts in by sending a base.
      if ('section_list_json' in filtered && typeof req.body?.baseSectionListJson === 'string') {
        try {
          const current = await fetchInspectionById(id);
          const currentJson = current?.sectionListJson || '';
          if (currentJson !== req.body.baseSectionListJson) {
            return res.status(409).json({ error: 'conflict', currentSectionListJson: currentJson });
          }
        } catch (e) {
          // Fail-open: if we can't read the current value, proceed rather than
          // block a legitimate save.
          console.warn(`PATCH /api/inspections/${id} CAS read failed (continuing):`, e);
        }
      }
      await updateInspection(id, filtered);
      return res.status(200).json({ success: true });
    } catch (e: any) {
      console.error(`PATCH /api/inspections/${id} failed:`, e);
      return res.status(500).json({ error: 'Could not save changes. Please try again.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
