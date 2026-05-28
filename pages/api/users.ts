import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchUsers } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const users = await fetchUsers();
    return res.status(200).json({ users });
  } catch (e: any) {
    console.error('GET /api/users failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
