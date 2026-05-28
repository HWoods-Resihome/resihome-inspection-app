import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await getSessionFromRequest(req);
  if (!user) return res.status(401).json({ authenticated: false });
  return res.status(200).json({ authenticated: true, user });
}
