/**
 * GET /api/inspections/[id]/report-pdf — LIVE report render.
 *
 * Renders the question-driven inspection report (1099 / Vacancy / Community /
 * RRQC) from CURRENT HubSpot data and streams it (no-store), without touching the
 * stored pdf_attachment_url. The in-app "View PDF Report" points here so a report
 * ALWAYS reflects the latest format/data with no manual regeneration; the stored
 * file remains for emailed/shared copies.
 *
 * Speed: the build (photo embedding) is the slow part, so the rendered buffer is
 * cached per (inspection, last-modified). Repeat opens are instant; it only
 * re-renders after the inspection changes. `?warm=1` builds+caches and returns
 * 204 (no body) — the inspection page pre-warms this on load so the first open
 * is already hot. Shares buildReportPdfBuffer with the admin regenerate tool.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { buildReportPdfBuffer } from '@/pages/api/admin/regenerate-inspection-pdfs';
import { readInspectionProps } from '@/lib/hubspot';
import { reqOriginOf } from '@/lib/appUrl';

export const config = { maxDuration: 60 };

// Per-instance rendered-buffer cache, keyed by inspection + last-modified so any
// edit/regenerate re-renders once and every other open is instant.
const RENDER_TTL_MS = 30 * 60 * 1000;
const _cache = new Map<string, { at: number; buf: Buffer }>();
function prune() {
  if (_cache.size <= 120) return;
  const oldest = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, _cache.size - 120);
  for (const [k] of oldest) _cache.delete(k);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }

  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid inspection id' });
  const warm = req.query.warm === '1' || req.query.warm === 'true';

  try {
    // Cheap read of the last-modified time to key the cache (busts on any edit).
    let lastMod = '';
    try { const p = await readInspectionProps(id, ['hs_lastmodifieddate']); lastMod = String(p?.hs_lastmodifieddate || ''); } catch { /* key without it */ }
    const key = `${id}:${lastMod}`;

    let buf = _cache.get(key)?.buf;
    if (buf) _cache.set(key, { at: Date.now(), buf }); // refresh recency
    else {
      const r = await buildReportPdfBuffer(id, reqOriginOf(req) || undefined);
      if (!r.ok) return res.status(r.error === 'Inspection not found' ? 404 : 400).json({ error: r.error });
      buf = r.buf;
      _cache.set(key, { at: Date.now(), buf });
      prune();
    }

    if (warm) return res.status(204).end(); // pre-warm: cached, nothing to send

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="inspection-report.pdf"');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    return res.status(200).send(buf);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
