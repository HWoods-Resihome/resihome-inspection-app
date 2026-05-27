import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchProperties } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const properties = await fetchProperties();
    return res.status(200).json({ properties });
  } catch (e: any) {
    console.error('GET /api/properties failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
