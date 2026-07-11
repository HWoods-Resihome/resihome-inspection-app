/**
 * POST /api/services/[id]/submit — Phase 4: field crew submits a completed service.
 *
 * Writes the completion form answers + before/after (and pet-station) photo URLs
 * to the Service Work Order and moves it to **submitted** with a submitted_at
 * timestamp. Status stays "submitted" (the "AI Processing" tag is derived from
 * that on the list) until the Phase 5 AI review either auto-completes it or routes
 * it to Review. Internal-gated. Photos are uploaded client-side; only URLs arrive.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { patchServiceWorkOrder } from '@/lib/hubspot';

const cleanUrls = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((u) => String(u || '').trim()).filter(Boolean) : [];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });

  const b = req.body || {};
  const before = cleanUrls(b.before);
  const after = cleanUrls(b.after);
  const petBefore = cleanUrls(b.petBefore);
  const petAfter = cleanUrls(b.petAfter);
  const answers = b.answers && typeof b.answers === 'object' ? b.answers : {};
  // submittedAt comes from the client (server clock is fine too); ISO 8601.
  const submittedAt = typeof b.submittedAt === 'string' && b.submittedAt ? b.submittedAt : new Date().toISOString();

  const props: Record<string, any> = {
    status: 'submitted',
    submitted_at: submittedAt,
    answers_json: JSON.stringify(answers),
    before_photo_urls: before.join('\n'),
    after_photo_urls: after.join('\n'),
    pet_before_photo_urls: petBefore.join('\n'),
    pet_after_photo_urls: petAfter.join('\n'),
  };

  try {
    const okp = await patchServiceWorkOrder(id, props);
    if (!okp) return res.status(200).json({ ok: true, preview: true }); // object not configured
    return res.status(200).json({ ok: true, id, status: 'submitted' });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
