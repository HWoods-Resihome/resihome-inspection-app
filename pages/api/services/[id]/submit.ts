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
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';
import { runServiceAiReview } from '@/lib/services/aiReview';

// The AI review call (Claude vision) can take a few seconds — allow headroom so
// the review runs inline the moment the work order is submitted.
export const config = { maxDuration: 120 };

const cleanUrls = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((u) => String(u || '').trim()).filter(Boolean) : [];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  // The assigned crew/vendor completes the service; allow any authorized Services
  // user. Once the order has left the editable states it's locked (view-only).
  const ok = await servicesEnabled(email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not authorized' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });

  // Lock: a service that's already submitted/under review/completed/canceled can
  // no longer be edited or re-submitted.
  const existing = await fetchServiceWorkOrder(id).catch(() => null);
  if (existing && ['submitted', 'review', 'completed', 'canceled'].includes(String(existing.props.status || ''))) {
    return res.status(409).json({ error: `This service is ${existing.props.status} and can no longer be edited.` });
  }

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

    // Kick the AI review for THIS order immediately — don't wait for the nightly
    // bulk cron. Best-effort: if it errors (e.g. ANTHROPIC_API_KEY missing) the
    // order stays "submitted" and the cron picks it up. Result surfaced to the client.
    let review: { verdict: string; status: string } | null = null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const rep = await runServiceAiReview(true, today, id);
      const item = rep?.items?.find((i) => i.id === id) || rep?.items?.[0];
      if (item) review = { verdict: item.verdict, status: item.action === 'completed' ? 'completed' : item.action === 'review' ? 'review' : 'submitted' };
    } catch (e) { console.warn('[services/submit] inline AI review failed (cron will retry):', e); }

    return res.status(200).json({ ok: true, id, status: review?.status || 'submitted', review });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
