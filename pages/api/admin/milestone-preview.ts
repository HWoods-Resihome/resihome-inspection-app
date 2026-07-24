/**
 * POST /api/admin/milestone-preview — TEMP admin preview of the 1,000-completed-
 * inspections milestone email. Sends it from the system mailbox to
 * hwoods@resihome.com so the celebration can be previewed before it's wired to
 * the real milestone trigger. Admin-gated.
 *
 * Body (optional): { to?, name? } — override the recipient / greeting name.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { sendMilestone1kPreview } from '@/lib/notifications/milestone1k';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session || !(await isAppAdmin(session.email).catch(() => false))) return res.status(403).json({ error: 'Admin only' });

  const body = req.body || {};
  const to = typeof body.to === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.to.trim())
    ? body.to.trim() : 'hwoods@resihome.com';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  try {
    const r = await sendMilestone1kPreview(to, name);
    if (!r.sent) return res.status(502).json({ error: r.error || 'Send failed' });
    return res.status(200).json({ sent: true, to });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
