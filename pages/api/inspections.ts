import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchInspections } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const inspections = await fetchInspections();
    return res.status(200).json({ inspections });
  } catch (e: any) {
    console.error('GET /api/inspections failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
