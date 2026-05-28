import type { NextApiRequest, NextApiResponse } from 'next';
import {
  fetchInspectionWithPropertyRef,
  fetchAnswersForInspection,
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
      await updateInspection(id, props);
      return res.status(200).json({ success: true });
    } catch (e: any) {
      console.error(`PATCH /api/inspections/${id} failed:`, e);
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
