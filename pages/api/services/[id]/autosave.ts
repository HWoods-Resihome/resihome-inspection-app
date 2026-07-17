/**
 * POST /api/services/[id]/autosave — mid-completion draft autosave.
 *
 * As a crew member fills in the completion form (answers + before/after/pet
 * photos), the client debounce-posts the in-progress draft here so nothing is
 * lost if they navigate away, switch devices, or close the app before hitting
 * Submit. This ONLY persists the draft — it does NOT change status (the order
 * stays estimated/assigned) and never spawns bids or runs AI review. Submit is
 * the single place that moves the order to "submitted".
 *
 * Editable statuses only ('' / estimated / assigned); a submitted/review/
 * completed/canceled order — or a bid item — refuses the write (409). Services-
 * gated. Photos are uploaded client-side; only hosted URLs arrive (blob: drafts
 * are dropped client-side and never sent). Best-effort — a failed autosave never
 * blocks editing (localStorage still covers the same device).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { resolveServiceViewerAsync, servicesViewerAllowed } from '@/lib/services/scopeServer';
import { serviceVisibleTo } from '@/lib/services/scope';
import type { SampleService } from '@/lib/services/sampleData';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';

const EDITABLE = new Set(['', 'estimated', 'assigned']);
// Only ever store hosted URLs (a blob: draft is dead after a reload).
const cleanUrls = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u.split('#')[0])) : [];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const ok = await servicesViewerAllowed(session?.email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not authorized' });

  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Autosave is available for live services only.' });

  try {
    const existing = await fetchServiceWorkOrder(id).catch(() => null);
    if (!existing) return res.status(200).json({ ok: true, preview: true }); // not configured / not found
    // Ownership: a vendor may only draft a work order assigned to THEM.
    const viewer = await resolveServiceViewerAsync(session, req);
    if (!viewer.canSeeAll && !serviceVisibleTo(
      { vendor: existing.props.vendor_name || null, vendorEmail: String(existing.props.vendor_email || '').trim() || null } as SampleService,
      viewer,
    )) {
      return res.status(403).json({ error: 'Not authorized for this service.' });
    }
    const status = String(existing.props.status || '');
    const isBid = existing.props.is_bid_item === 'true';
    if (!EDITABLE.has(status) || isBid) {
      return res.status(409).json({ error: `This service is ${status || 'not editable'} and can no longer be drafted.` });
    }

    const b = req.body || {};
    const answers = b.answers && typeof b.answers === 'object' ? b.answers : {};
    const props: Record<string, any> = {
      // NOTE: status is intentionally NOT set — a draft stays estimated/assigned.
      answers_json: JSON.stringify(answers),
      before_photo_urls: cleanUrls(b.before).join('\n'),
      after_photo_urls: cleanUrls(b.after).join('\n'),
      pet_before_photo_urls: cleanUrls(b.petBefore).join('\n'),
      pet_after_photo_urls: cleanUrls(b.petAfter).join('\n'),
    };
    await patchServiceWorkOrder(id, props);
    return res.status(200).json({ ok: true, id });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
