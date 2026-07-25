/**
 * /api/cron/photo-gap-sweep — safety net for lost required photos.
 *
 * A required inspection photo can strand on the inspector's device (weak signal
 * at capture, then they close the app before it uploads — there's no reliable
 * iOS background sync). The durable queue attaches it whenever the app is next
 * open online, but if the inspector never comes back, the completed record is
 * silently missing evidence — nobody finds out.
 *
 * This sweep closes that hole: once a day it looks at inspections completed in a
 * window that has ALREADY had a grace period for background sync to land photos,
 * and emails a digest of any that are STILL missing a required photo — so QC can
 * chase the inspector (their app may just need reopening) or re-inspect. It never
 * writes anything; detection only.
 *
 * The window ([now-GRACE-24h, now-GRACE]) is a 24h band offset by the grace
 * period, so a daily run reports each completed inspection exactly once (no
 * per-record dedupe state needed). Auth: CRON_SECRET (Bearer / ?key=) or an
 * app-admin session (so an admin can open ?dryRun=1 to preview).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { searchInspectionsPage } from '@/lib/hubspot';
import type { Question } from '@/lib/types';
import { questionMapForTemplate, photoGapsForInspection, type PhotoGap } from '@/lib/photoGaps';
import { sendNotificationEmail, appBaseUrl } from '@/lib/notifications/send';
import { templateLabel } from '@/lib/templateLabels';

export const config = { maxDuration: 300 };

// Give background sync a chance to land stranded photos before we alert — an
// inspector who reopens the app on wifi within this window heals it silently.
const GRACE_MS = 4 * 60 * 60 * 1000;   // 4 hours
const BAND_MS = 24 * 60 * 60 * 1000;   // one day — matches the daily cadence
// Where the digest goes. QC/ops inbox; overridable.
const INBOX = (process.env.PHOTO_GAP_INBOX || process.env.SERVICES_ALERTS_INBOX || 'services@resihome.com').trim();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  let authorized = !!secret && provided === secret;
  if (!authorized) {
    const session = await getSessionFromRequest(req).catch(() => null);
    authorized = !!session?.email && (await isAppAdmin(session.email).catch(() => false));
  }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  const dryRun = req.query.dryRun === '1' || req.query.dry === '1';
  // Tunable window for manual runs: ?graceHours= & ?bandHours=.
  const graceMs = Math.max(0, Number(req.query.graceHours) * 3600_000 || GRACE_MS);
  const bandMs = Math.max(3600_000, Number(req.query.bandHours) * 3600_000 || BAND_MS);
  const now = Date.now();
  const newest = now - graceMs;            // completed at least `grace` ago
  const oldest = now - graceMs - bandMs;   // …but within the band

  const cache = new Map<string, Map<string, Question>>();
  const flagged: Array<{ inspectionId: string; address: string; templateType: string; completedAt: string | null; gaps: PhotoGap[] }> = [];

  try {
    const pageSize = 100;
    let page = 1;
    let scanned = 0;
    const HARD_CAP = 1000; // safety bound on a huge backlog
    outer: while (scanned < HARD_CAP) {
      const { items } = await searchInspectionsPage({ status: 'completed', sortField: 'updated', sortDir: 'desc', page, pageSize });
      if (items.length === 0) break;
      for (const it of items) {
        scanned++;
        const completedMs = it.completedAt ? Date.parse(it.completedAt) : NaN;
        if (!Number.isFinite(completedMs)) continue;
        // Sorted by recency: once we're older than the band, everything after is too.
        if (completedMs < oldest) break outer;
        if (completedMs > newest) continue; // still inside the grace period — skip
        const qMap = await questionMapForTemplate(it.templateType, cache);
        const gaps = await photoGapsForInspection(it.recordId, qMap);
        if (gaps.length > 0) {
          flagged.push({ inspectionId: it.recordId, address: it.propertyAddressSnapshot || it.inspectionName || '', templateType: it.templateType, completedAt: it.completedAt, gaps });
        }
      }
      if (items.length < pageSize) break;
      page++;
    }

    const base = appBaseUrl(req);
    let emailed = false;
    if (flagged.length > 0 && !dryRun) {
      const rows: Array<[string, string]> = flagged.map((f) => [
        f.address || f.inspectionId,
        `${f.gaps.length} missing: ${f.gaps.map((g) => g.questionText).join(', ')}`,
      ]);
      const r = await sendNotificationEmail({
        to: INBOX,
        subject: `Photo gaps: ${flagged.length} completed inspection${flagged.length === 1 ? '' : 's'} missing required photos`,
        heading: 'Required photos missing',
        intro: `${flagged.length} completed inspection${flagged.length === 1 ? '' : 's'} still ${flagged.length === 1 ? 'is' : 'are'} missing ${flagged.length === 1 ? 'a' : ''} required photo${flagged.length === 1 ? '' : 's'} after the sync grace period — the photos didn't reach the record. Reopen the inspector's app on wifi, or re-inspect.`,
        rows: rows.slice(0, 50),
        linkUrl: `${base}/inspection/${encodeURIComponent(flagged[0].inspectionId)}`,
        linkLabel: 'Open first inspection',
      });
      emailed = r.sent;
    }

    return res.status(200).json({
      window: { newest: new Date(newest).toISOString(), oldest: new Date(oldest).toISOString(), graceHours: graceMs / 3600_000, bandHours: bandMs / 3600_000 },
      scanned,
      flagged: flagged.length,
      emailed,
      inbox: INBOX,
      dryRun,
      rows: flagged.map((f) => ({ inspectionId: f.inspectionId, address: f.address, completedAt: f.completedAt, missing: f.gaps.map((g) => g.questionText) })),
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
