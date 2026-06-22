/**
 * GET|POST /api/admin/backfill-pending-master  (app-admin only)
 *
 * Generate the review (Master) PDF for SCOPE inspections that are in
 * submitted / pending-approval but have no pdf_master_url yet (e.g. submitted
 * before server-side review-PDF generation existed) — so the in-app "View PDFs"
 * link appears on them. Per scope it calls the finalize "regenerate" path, which
 * rebuilds + stores the PDFs WITHOUT changing status or sending email/ticket.
 *
 * Skips scopes that already have a Master. AUTO-DRAINS within a ~250s budget
 * (each generation is ~15-20s, so only a handful per pass) and returns a
 * `resume` URL when more remain. Idempotent.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, readInspectionProps } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

const norm = (s: string) => (s || '').trim().toLowerCase().replace(/[ -]/g, '_');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  if (!host) return res.status(500).json({ error: 'Could not resolve request host.' });
  const origin = `${proto}://${host}`;

  const startIdx = Math.max(0, Number(req.query.after) || 0);
  const deadline = Date.now() + 250_000;

  try {
    const all = await fetchInspections();
    // Scope rate cards awaiting approval (submitted / pending_approval).
    const targets = all.filter((i) => {
      const st = norm(i.status);
      return i.templateType === 'pm_scope_rate_card' && (st === 'submitted' || st === 'pending_approval');
    });

    let processed = 0, generated = 0, skippedHasMaster = 0, errors = 0;
    const errorSamples: string[] = [];
    let i = startIdx;
    for (; i < targets.length; i++) {
      const insp = targets[i];
      processed++;
      try {
        const props = await readInspectionProps(insp.recordId, ['pdf_master_url']);
        if ((props?.pdf_master_url || '').toString().trim()) { skippedHasMaster++; }
        else {
          const r = await fetch(`${origin}/api/inspections/${insp.recordId}/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: req.headers.cookie || '' },
            body: JSON.stringify({ regenerateOnly: true }),
          });
          if (!r.ok) throw new Error(`finalize HTTP ${r.status}`);
          generated++;
        }
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 8) errorSamples.push(`${insp.recordId}: ${String(e?.detail || e?.message || e).slice(0, 160)}`);
      }
      if (Date.now() > deadline) { i++; break; }
    }

    const done = i >= targets.length;
    const nextAfter = done ? null : i;
    return res.status(200).json({
      ok: true,
      pendingScopes: targets.length,
      processed,
      generated,
      skippedHasMaster,
      errors,
      done,
      nextAfter,
      resume: nextAfter != null ? `/api/admin/backfill-pending-master?after=${nextAfter}` : null,
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-pending-master] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
