/**
 * POST /api/services/ai-learning — synthesize ✨ AI-learned Services checks from
 * reviewer decisions (approve / modify / reject + the reason a service went to
 * review), merge them into the stored checks, and return the full merged array
 * so the Services AI Knowledge tab (which bulk-saves the whole array) adopts
 * them. Admin-gated. The AI review call can take a few seconds.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { refreshServiceChecksFromReviews } from '@/lib/services/serviceLearning';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  try {
    const r = await refreshServiceChecksFromReviews();
    return res.status(200).json({ ok: true, ...r });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
