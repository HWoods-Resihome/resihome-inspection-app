/**
 * GET /api/admin/delete-rate-card-line
 *
 * Removes the "Whole House touch up 2-3 gallons" line item from the live rate-
 * card matrix. "Delete" = set is_active=false, so it drops out of the catalog
 * everywhere (the catalog fetch filters is_active='true') but is reversible (no
 * data destroyed — flip it back in HubSpot to restore).
 *
 * SAFE: dry-run by default — open the URL signed in as @resihome.com to see
 * EXACTLY which record(s) it would remove (plus the other whole-house touch-up
 * variants for context, so you can confirm it's targeting the right one). Add
 * ?apply=1 to actually deactivate, then it refreshes the catalog cache.
 *
 * Override the match with ?code=<line_item_code> to target an exact item.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchRateCardCatalog, deactivateRateCardLineItem } from '@/lib/hubspot';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });

  const apply = req.query.apply === '1';
  const exactCode = typeof req.query.code === 'string' ? req.query.code.trim() : '';

  const view = (it: any) => ({
    recordId: it.recordId,
    lineItemCode: it.lineItemCode,
    description: it.laborShortDescription,
    category: it.category,
    subcategory: it.subcategory,
    unit: it.laborMeas,
  });

  try {
    const catalog = await fetchRateCardCatalog(); // active items only
    const hay = (it: any) =>
      [it.category, it.subcategory, it.laborShortDescription, it.laborFullDescription, it.laborSubtext]
        .join(' ').toLowerCase();

    // Free-text finder: ?q=touch  (or gallon, paint, mist…) lists matches so you
    // can grab the exact line_item_code, then delete with ?code=<code>&apply=1.
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    if (q && !exactCode) {
      const matches = catalog.filter((it) => hay(it).includes(q) || it.lineItemCode.toLowerCase().includes(q));
      return res.status(200).json({
        ok: true,
        applied: false,
        query: q,
        count: matches.length,
        matches: matches.map(view),
        note: 'Finder results. To delete one, re-run with ?code=<line_item_code>&apply=1',
      });
    }

    // Target: an exact code, else best-effort "whole house touch up 2-3 gallons".
    const targets = exactCode
      ? catalog.filter((it) => it.lineItemCode === exactCode)
      : catalog.filter((it) => {
          const h = hay(it);
          return /touch.?up/.test(h) && /gallon/.test(h) && /2\s*(?:-|–|—|to)\s*3/.test(h);
        });

    if (targets.length === 0) {
      // Help locate it: surface anything touch-up / gallon / paint related.
      const candidates = catalog.filter((it) => /touch|gallon|mist|paint/i.test(hay(it)));
      return res.status(200).json({
        ok: true,
        applied: false,
        message: 'No exact match. Use the candidates below to find the right line_item_code, then re-run with ?code=<line_item_code>&apply=1 — or search with ?q=<text>.',
        targets: [],
        candidates: candidates.map(view),
      });
    }

    if (!apply) {
      return res.status(200).json({
        ok: true,
        applied: false,
        dryRun: true,
        wouldRemove: targets.map(view),
        note: 'Dry run — nothing changed. Add ?apply=1 to this URL to remove these from the matrix.',
      });
    }

    const removed: any[] = [];
    const errors: any[] = [];
    for (const t of targets) {
      try {
        await deactivateRateCardLineItem(t.recordId);
        removed.push(view(t));
      } catch (e: any) {
        errors.push({ ...view(t), error: String(e?.message || e).slice(0, 160) });
      }
    }
    // Refresh the cached catalog so the matrix reflects the removal immediately.
    try { await getCachedCatalog(true); } catch { /* cache will refresh on its own TTL */ }

    return res.status(200).json({ ok: errors.length === 0, applied: true, removed, errors });
  } catch (e: any) {
    console.error('delete-rate-card-line failed:', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}
