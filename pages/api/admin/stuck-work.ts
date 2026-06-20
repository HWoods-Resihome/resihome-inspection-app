import type { NextApiRequest, NextApiResponse } from 'next';
import { list } from '@vercel/blob';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';

/**
 * GET /api/admin/stuck-work?days=14
 *
 * Inspections whose offline edits/photos aren't draining. Reads the latest
 * per-inspection sync-health record (written by /api/telemetry/sync) and
 * returns those with work still queued (remaining > 0) or permanently dropped
 * after exhausting retries (failedPermanently > 0). A clean flush overwrites the
 * record with remaining 0, so recovered inspections self-clear.
 *
 * `failedPermanently > 0` is the urgent case: an inspector's edit/photo was
 * LOST and needs manual recovery. Gated to @resihome.com staff. Read-only.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(200).json({ items: [], note: 'Blob storage not configured.' });
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
    const cutoffMs = Date.now() - days * 864e5;

    const records: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: 'sync-health/', cursor, limit: 1000 });
      const loaded = await Promise.all(page.blobs.map((b) => fetch(b.url).then((r) => r.json()).catch(() => null)));
      for (const r of loaded) if (r) records.push(r);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    const items = records
      .filter((r) => new Date(r.updatedAt).getTime() >= cutoffMs)
      .filter((r) => (r.remaining || 0) > 0 || (r.failedPermanently || 0) > 0)
      .sort((a, b) => (b.failedPermanently || 0) - (a.failedPermanently || 0) || (b.remaining || 0) - (a.remaining || 0));

    return res.status(200).json({
      days,
      counts: {
        flagged: items.length,
        withDataLoss: items.filter((r) => (r.failedPermanently || 0) > 0).length,
        stillQueued: items.filter((r) => (r.remaining || 0) > 0).length,
      },
      items,
    });
  } catch (e: any) {
    console.error('[stuck-work] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
