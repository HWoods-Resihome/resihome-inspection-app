// GET /api/properties/[id]/rate-card-inspections
// Returns the submitted/completed Scope Rate Card inspections for a property,
// most-recently-submitted first. Used by the QC Turn Re-Inspect new-inspection
// flow to populate the dependent "source inspection" dropdown.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchSourceRateCardInspections } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const id = req.query.id;
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'Missing property id' });
    return;
  }
  try {
    const options = await fetchSourceRateCardInspections(id);
    res.status(200).json({ options });
  } catch (e: any) {
    console.error('[rate-card-inspections] failed:', e);
    res.status(500).json({ error: String(e?.message || e) });
  }
}
