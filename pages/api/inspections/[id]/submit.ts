import type { NextApiRequest, NextApiResponse } from 'next';
import { updateInspection, fetchInspectionById } from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';

/**
 * Finalize an existing inspection. All answers should already be saved via
 * autosave. This endpoint just sets status=Completed, completed_at, and
 * touches up any inspection-level summary fields.
 *
 * The PDF is generated separately via /api/pdf (unchanged from earlier rounds).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  try {
    const body = req.body || {};
    const totalQuestionsAnswered: number | undefined = body.totalQuestionsAnswered;
    const totalPhotos: number | undefined = body.totalPhotos;

    const props: Record<string, any> = {
      status: 'completed',
      completed_at: new Date().toISOString(),
      confirm_reviewed: 'yes',
    };
    if (typeof totalQuestionsAnswered === 'number') {
      props.total_questions_answered = totalQuestionsAnswered;
    }
    if (typeof totalPhotos === 'number') {
      props.total_photos_attached = totalPhotos;
    }

    await updateInspection(id, props);
    const inspection = await fetchInspectionById(id);

    return res.status(200).json({
      success: true,
      inspectionRecordId: id,
      inspection,
      hubspotUrl: `https://app.hubspot.com/contacts/51415639/record/${process.env.HUBSPOT_INSPECTION_TYPE_ID}/${id}`,
    });
  } catch (e: any) {
    console.error(`POST /api/inspections/${id}/submit failed:`, e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
