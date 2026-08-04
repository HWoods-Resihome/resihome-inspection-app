/**
 * GET /api/cron/ticket-type-sweep — drains the durable ticket-type enforcement
 * queue INDEPENDENTLY of any browser session, so a user closing the tab or
 * navigating away right after finalize can never prevent the HoneyBadger ticket
 * type from being forced (Turnkey / Evictions). For each due job it runs the same
 * retry-until-confirmed UI enforcement finalize uses; on confirmation it removes
 * the job, otherwise it bumps the attempt (giving up after ENFORCE_MAX_ATTEMPTS).
 *
 * Requires CRON_SECRET. Idempotent — a ticket already at the target reads back as
 * such and is removed on the next pass.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  listTicketEnforceJobs, removeTicketEnforcement, bumpTicketEnforcement, touchTicketEnforcement,
} from '@/lib/ticketEnforceQueue';
import { setTicketTypeViaUi, uploadTicketDocuments, type TicketUploadFile } from '@/lib/ticketUpload';
import { fetchInspectionWithPropertyRef } from '@/lib/hubspot';
import { vendorGetsOwnPdf, vendorTicketKind } from '@/lib/vendors';

// Docs jobs: rebuild the upload plan for one of a Scope's tickets from the
// inspection (mirrors the live upload-ticket-docs plan). `which` selects the
// PDF set: turnkey = Master + standard-trade vendor PDFs; eviction/capex = only
// that kind's vendor PDFs (no Master). Empty when the record can't be loaded.
async function ticketFilesFor(inspectionId: string, which: 'turnkey' | 'eviction' | 'capex' = 'turnkey'): Promise<TicketUploadFile[]> {
  const data = await fetchInspectionWithPropertyRef(inspectionId).catch(() => null);
  if (!data) return [];
  const nameFromUrl = (url: string, fallback: string) => {
    try { const seg = new URL(url).pathname.split('/').pop(); if (seg) return decodeURIComponent(seg); } catch { /* keep */ }
    return fallback;
  };
  const files: TicketUploadFile[] = [];
  if (which === 'turnkey') {
    const masterUrl = data.inspection.pdfMasterUrl || '';
    if (masterUrl) files.push({ name: nameFromUrl(masterUrl, 'Master Rate Card.pdf'), url: masterUrl });
  }
  if (data.inspection.pdfVendorUrlsJson) {
    try {
      const map = JSON.parse(data.inspection.pdfVendorUrlsJson) || {};
      for (const [vendor, url] of Object.entries(map)) {
        if (vendorGetsOwnPdf(vendor) && vendorTicketKind(vendor) === which && typeof url === 'string' && url) {
          files.push({ name: nameFromUrl(url, `${vendor} Rate Card.pdf`), url });
        }
      }
    } catch { /* malformed — master-only */ }
  }
  return files;
}

// A browser run is slow; allow the full serverless ceiling.
export const config = { maxDuration: 300 };

// Skip a job attempted within this window so overlapping cron ticks don't stack
// two browser sessions on the same ticket.
const COOLDOWN_MS = Number(process.env.HBMM_ENFORCE_COOLDOWN_MS || 90_000) || 90_000;
// Bound browser runs per invocation to stay comfortably under maxDuration.
const BATCH = Math.max(1, Number(process.env.HBMM_ENFORCE_BATCH || 3) || 3);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  const auth = req.headers.authorization || '';
  let authorized = !!secret && auth === `Bearer ${secret}`;
  if (!authorized) {
    // Admin session → manual trigger (watch a docs-backfill test run live).
    const { getSessionFromRequest } = await import('@/lib/auth');
    const { isAppAdmin } = await import('@/lib/adminAccess');
    const session = await getSessionFromRequest(req).catch(() => null);
    authorized = !!session?.email && (await isAppAdmin(session.email).catch(() => false));
  }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

  const all = await listTicketEnforceJobs();
  const now = Date.now();
  const due = all
    .filter((j) => !j.lastAttemptAt || (now - Date.parse(j.lastAttemptAt) >= COOLDOWN_MS))
    .sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : a.enqueuedAt > b.enqueuedAt ? 1 : 0))
    .slice(0, BATCH);

  const results: any[] = [];
  for (const job of due) {
    // Claim it (stamp lastAttemptAt) BEFORE the slow browser run so a concurrent
    // tick within the cooldown skips it.
    await touchTicketEnforcement(job.ticketId);
    try {
      // Docs job → one browser run uploads the PDFs AND enforces the type;
      // plain job → the type-only run as before.
      const docFiles = job.docs && job.inspectionId ? await ticketFilesFor(job.inspectionId, job.which || 'turnkey') : [];
      const ui = docFiles.length
        ? await uploadTicketDocuments({ ticketId: job.ticketId, files: docFiles, ticketTypeTarget: job.target, skipIfHasDocs: true })
        : await setTicketTypeViaUi({ ticketId: job.ticketId, target: job.target });
      if (ui.ok) {
        await removeTicketEnforcement(job.ticketId);
        results.push({ ticketId: job.ticketId, outcome: 'confirmed' });
      } else {
        const b = await bumpTicketEnforcement(job.ticketId);
        results.push({ ticketId: job.ticketId, outcome: b.dropped ? 'gave-up' : 'retry', attempts: b.attempts, error: ui.error });
        console.warn(`[ticket-type-sweep] #${job.ticketId} not confirmed (attempt ${b.attempts}${b.dropped ? ', GIVING UP' : ''}): ${ui.error || ''}\n  ${ui.steps.slice(-6).join('\n  ')}`);
      }
    } catch (e: any) {
      const b = await bumpTicketEnforcement(job.ticketId);
      results.push({ ticketId: job.ticketId, outcome: b.dropped ? 'gave-up-error' : 'retry-error', attempts: b.attempts, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return res.status(200).json({ ok: true, queued: all.length, attempted: due.length, results });
}
