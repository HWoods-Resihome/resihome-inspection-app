/**
 * GET /api/cron/finalize-backstop — the "always happens" guarantee for two
 * best-effort finalize side effects that were observed silently failing:
 *
 *   1. PENDING-APPROVAL PDFs: submit pre-generates the review (Master) PDF via
 *      a bounded best-effort self-call — a hung photo / 75s abort leaves the
 *      scope in pending approval with NO PDF link (e.g. 1305 Duvall). Sweep:
 *      pending-approval inspections missing pdf_master_url → re-run the
 *      finalize regenerateOnly path (CRON bearer; no status flip, no emails).
 *
 *   2. HBMM MAINTENANCE TICKETS: the finalize ticket create is best-effort and
 *      console-only on failure, so an API/env blip meant tickets were entered
 *      by hand. Sweep: recently-completed scopes (pdf_generated_at proves the
 *      finalize pipeline ran) missing hbmm_ticket_id → re-create the Turnkey
 *      ticket with the exact finalize recipe (stored pdf_vendor_urls_json +
 *      regenerated /d/ short links), then stamp + enqueue type enforcement.
 *      Deduped by a fresh hbmm_ticket_id re-read right before the create.
 *
 * Auth: Vercel Cron (CRON_SECRET bearer / ?key=) OR an app-admin session, so
 * an admin can open ?dryRun=1 in the browser to see the current gap list and
 * config state without sending anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  searchInspectionsMissingProp, readInspectionProps, updateInspection,
  fetchInspectionWithPropertyRef,
} from '@/lib/hubspot';
import { createMaintenanceTicket, buildTicketDescription } from '@/lib/maintenanceAi';
import { vendorTicketKind } from '@/lib/vendors';
import { buildShortLink } from '@/lib/shortLinks';
import { enqueueTicketEnforcement } from '@/lib/ticketEnforceQueue';
import { appBaseUrl } from '@/lib/notifications/send';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';

export const config = { maxDuration: 300 };

const PENDING_STATUSES = ['pending_approval', 'pending approval', 'pending-approval', 'pendingapproval', 'Pending Approval'];
const COMPLETED_STATUSES = ['completed', 'complete', 'Completed'];
const TICKET_WINDOW_MS = 72 * 3600_000;
const PDF_FIXES_PER_RUN = 3;    // each regenerate can take ~60s
const TICKET_FIXES_PER_RUN = 5;

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
  // ?all=1 — manual catch-up mode: process the WHOLE candidate list in this one
  // request instead of the cron's gentle 5-per-pass pace (used to clear the
  // missed-ticket backlog after the API key restore). Ticket creates are a few
  // seconds each, so 25-50 fit comfortably inside maxDuration; the PDF cap
  // stays small because each regenerate can take ~60s.
  const all = req.query.all === '1';
  const ticketCap = all ? 50 : TICKET_FIXES_PER_RUN;
  const base = appBaseUrl();

  // Audit mode: ?stamped=1 lists recent completions WITH their hbmm_ticket_id so
  // wrong-environment stamps (created while the base URL pointed at dev) can be
  // identified in full — the cron kept stamping between the key restore and the
  // base-URL fix, beyond the known ?all=1 batch.
  if (req.query.stamped === '1') {
    const rows = await searchInspectionsMissingProp({
      statusValues: COMPLETED_STATUSES,
      requireProp: 'hbmm_ticket_id', sinceProp: 'completed_at', sinceMs: Date.now() - TICKET_WINDOW_MS,
      props: ['hbmm_ticket_id', 'completed_at'], limit: 100,
    }).catch(() => []);
    return res.status(200).json({
      ok: true,
      stamped: rows.map((r) => ({ id: r.id, ticketId: r.props.hbmm_ticket_id || '', completedAt: r.props.completed_at || null })),
    });
  }

  // One-off repair (wrong-environment creates): ?unstamp=<inspectionId>:<ticketId>,...
  // clears hbmm_ticket_id ONLY where it exactly matches the supplied (known-wrong)
  // ticket id, so the sweep re-creates those tickets in the corrected environment.
  // Any other value (a manual/correct stamp) is left untouched and reported.
  if (typeof req.query.unstamp === 'string' && req.query.unstamp.trim()) {
    const unstamped: { id: string; outcome: string }[] = [];
    for (const pair of req.query.unstamp.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [iid, tid] = pair.split(':');
      if (!/^\d+$/.test(iid || '') || !/^\d+$/.test(tid || '')) { unstamped.push({ id: pair, outcome: 'bad_pair' }); continue; }
      try {
        const cur = await readInspectionProps(iid, ['hbmm_ticket_id']).catch(() => null);
        const have = String(cur?.hbmm_ticket_id || '').trim();
        if (have !== tid) { unstamped.push({ id: iid, outcome: have ? `left_alone_(has_${have})` : 'already_empty' }); continue; }
        await updateInspection(iid, { hbmm_ticket_id: '' });
        unstamped.push({ id: iid, outcome: 'cleared' });
      } catch (e: any) { unstamped.push({ id: iid, outcome: `error: ${String(e?.message || e).slice(0, 120)}` }); }
    }
    return res.status(200).json({ ok: true, unstamped });
  }

  try {
    // ---- Sweep 1: pending-approval scopes with no master PDF -------------
    const pdfCandidates = await searchInspectionsMissingProp({
      statusValues: PENDING_STATUSES, missingProp: 'pdf_master_url',
      props: ['submitted_at'], limit: 25,
    }).catch((e) => { console.warn('[finalize-backstop] pdf search failed:', e?.message || e); return []; });

    const pdfResults: { id: string; outcome: string }[] = [];
    if (!dryRun && secret) {
      for (const c of pdfCandidates.slice(0, PDF_FIXES_PER_RUN)) {
        try {
          const r = await fetch(`${base}/api/inspections/${encodeURIComponent(c.id)}/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ regenerateOnly: true }),
          });
          pdfResults.push({ id: c.id, outcome: r.ok ? 'regenerated' : `http_${r.status}` });
        } catch (e: any) { pdfResults.push({ id: c.id, outcome: `error: ${String(e?.message || e).slice(0, 120)}` }); }
      }
    }

    // ---- Sweep 2: completed scopes with no HBMM ticket --------------------
    const ticketCandidates = await searchInspectionsMissingProp({
      statusValues: COMPLETED_STATUSES, missingProp: 'hbmm_ticket_id',
      requireProp: 'pdf_generated_at', sinceProp: 'completed_at', sinceMs: Date.now() - TICKET_WINDOW_MS,
      props: ['pdf_vendor_urls_json', 'pdf_master_url', 'completed_at'], limit: 25,
    }).catch((e) => { console.warn('[finalize-backstop] ticket search failed:', e?.message || e); return []; });

    const ticketResults: { id: string; outcome: string }[] = [];
    if (!dryRun) {
      for (const c of ticketCandidates.slice(0, ticketCap)) {
        try {
          // Dedup: a finalize (or a previous sweep) may have created it since the search.
          const fresh = await readInspectionProps(c.id, ['hbmm_ticket_id']).catch(() => null);
          if (String(fresh?.hbmm_ticket_id || '').trim()) { ticketResults.push({ id: c.id, outcome: 'already_created' }); continue; }
          const data = await fetchInspectionWithPropertyRef(c.id);
          const hbmmId = Number(data?.propertyHbmmId || '');
          if (!data?.propertyHbmmId || !Number.isFinite(hbmmId)) { ticketResults.push({ id: c.id, outcome: 'no_hbmm_property_id' }); continue; }
          // Rebuild the exact finalize ticket description from stored state:
          // per-vendor PDF map + deterministic signed /d/ short links.
          const vendorUrls: Record<string, string> = (() => { try { return JSON.parse(c.props.pdf_vendor_urls_json || '{}'); } catch { return {}; } })();
          const shareMasterUrl = String(c.props.pdf_master_url || '').trim() ? buildShortLink(base, c.id, 'master') : null;
          const shareVendorLinks: Record<string, string> = {};
          for (const vendor of Object.keys(vendorUrls)) {
            if (String(vendorUrls[vendor] || '').trim()) shareVendorLinks[vendor] = buildShortLink(base, c.id, 'vendor', vendor);
          }
          const turnkeyHasWork = Object.entries(vendorUrls).some(([v, u]) => (u || '').trim() && vendorTicketKind(v) === 'turnkey');
          const description = turnkeyHasWork
            ? buildTicketDescription(shareVendorLinks, shareMasterUrl, { kind: 'turnkey' })
            : `Zero Dollar Turn${shareMasterUrl ? `\n\nMaster: ${shareMasterUrl}` : ''}`;
          const created = await createMaintenanceTicket({ propertyId: hbmmId, description });
          if (created.ok && created.ticketId) {
            await updateInspection(c.id, { hbmm_ticket_id: created.ticketId });
            await enqueueTicketEnforcement(created.ticketId, (process.env.HBMM_TICKET_TYPE_TARGET || 'Turnkey').trim(), c.id).catch(() => {});
            ticketResults.push({ id: c.id, outcome: `created_#${created.ticketId}` });
          } else {
            ticketResults.push({ id: c.id, outcome: `failed: ${String(created.error || (created.configured ? 'unknown' : 'MAINTENANCE_AI not configured')).slice(0, 200)}` });
          }
        } catch (e: any) { ticketResults.push({ id: c.id, outcome: `error: ${String(e?.message || e).slice(0, 160)}` }); }
      }
    }

    const out = {
      ok: true, dryRun,
      maintenanceAiConfigured: !!(process.env.MAINTENANCE_AI_API_KEY || '').trim(),
      // WHICH HBMM the creates go to — the code default is the dev/int host, so
      // a missing/wrong MAINTENANCE_AI_BASE_URL silently creates tickets in the
      // wrong environment (real IDs, invisible in prod HBMM).
      maintenanceAiHost: (process.env.MAINTENANCE_AI_BASE_URL || 'https://hbmm-admin-int.resicapdev.com (CODE DEFAULT — dev/int!)').trim(),
      pdf: { candidates: pdfCandidates.map((c) => ({ id: c.id, submittedAt: c.props.submitted_at || null })), fixed: pdfResults },
      tickets: { candidates: ticketCandidates.map((c) => ({ id: c.id, completedAt: c.props.completed_at || null })), fixed: ticketResults },
    };
    console.log('[finalize-backstop]', JSON.stringify({ dryRun, pdfCandidates: pdfCandidates.length, ticketCandidates: ticketCandidates.length, pdfResults, ticketResults }));
    return res.status(200).json(out);
  } catch (e: any) {
    console.error('[finalize-backstop] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
