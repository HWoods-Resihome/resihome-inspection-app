/**
 * POST /api/services/ai-checks/save — persist the Service AI-review knowledge base
 * (all checks). Admin-gated. Body: { checks: AiCheck[] }. Stored as JSON on the
 * admin Agent record; read live by the AI review job.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { writeServiceAiChecks } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const checks = (req.body || {}).checks;
  if (!Array.isArray(checks)) return res.status(400).json({ error: 'checks array required' });
  try {
    const okw = await writeServiceAiChecks(checks);
    return res.status(200).json({ ok: okw, preview: !okw });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
