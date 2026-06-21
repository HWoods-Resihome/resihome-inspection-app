/**
 * GET /api/admin/backfill-maint-ticket-answers
 *
 * Backfills the synthetic maintenance-ticket answers
 * (question_id_external 'maint_ticket_request' / 'maint_ticket_description') on
 * already-completed 1099 / vacancy inspections that were finalized BEFORE we
 * started persisting them (commit that added the submit-time upsert).
 *
 * WHY a PDF parse: the inspector's Yes/No choice and the ticket description were
 * never written to the inspection record (the 1099 ticket path stores neither) —
 * the ONLY place they survive is the completed PDF itself, which already renders
 * the "Maintenance Ticket: Yes — Created / No" stat strip and the "Maintenance
 * ticket description" Review/Sign-Off row. We read those back and write the
 * answer records so the completed-inspection view shows the Yes/No selection and
 * a REGENERATED PDF keeps the maintenance-ticket question + description.
 *
 * SAFE: dry-run by default — open the URL signed in as an app admin to see what
 * it WOULD write. Add ?apply=1 to actually create the answers. Idempotent: skips
 * any inspection that already has a maint_ticket_request answer. Only touches
 * FAILED 1099/vacancy inspections (the only ones with the ticket widget).
 *
 * Paginates internally until done (or a ~250s budget); if `nextAfter` is
 * non-null, re-open with `?after=<cursor>` (and the same ?apply / ?limit) to
 * continue.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import {
  fetchInspections, readInspectionProps, fetchAnswersForInspection, upsertAnswers,
} from '@/lib/hubspot';
import { buildQaAnswerProps } from '@/lib/answerProps';

export const config = { maxDuration: 300 };

// Templates that have the failed-review maintenance-ticket widget.
const TEMPLATES = new Set([
  'leasing_agent_1099_property_inspection',
  'pm_vacancy_occupancy_check',
]);

// Synthetic question text the live submit saves — must match exactly so the PDF
// detectors (isMaintRequestQ / isMaintDescQ) recognize the regenerated rows.
const Q_REQUEST = 'Submit a maintenance ticket?';
const Q_DESCRIPTION = 'Maintenance ticket description';
const SUMMARY_KEY = 'review_signoff';

/** Pull all text out of a PDF buffer (pdfjs, Node legacy build — no worker). */
async function extractPdfText(buf: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('pdfjs-dist/legacy/build/pdf.js' as any);
  // The legacy build is UMD — under ESM interop its exports land on `.default`.
  const pdfjs = mod.getDocument ? mod : (mod.default || mod);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true,
  }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out += ' ' + content.items.map((it: any) => (typeof it.str === 'string' ? it.str : '')).join(' ');
  }
  try { await doc.destroy(); } catch { /* ignore */ }
  return out.replace(/\s+/g, ' ').trim();
}

/** Parse the maintenance-ticket outcome from the completed PDF's text. */
function parseMaintTicket(text: string): { wanted: 'Yes' | 'No'; description: string } {
  // Stat strip renders "Yes — Created" (em/en dash or hyphen) when a ticket was
  // raised, else "No". That's the authoritative Yes/No.
  const wanted: 'Yes' | 'No' = /Yes\s*[—–-]\s*Created/i.test(text) ? 'Yes' : 'No';
  let description = '';
  if (wanted === 'Yes') {
    // The Review/Sign-Off "Maintenance ticket description" row holds the text,
    // up to the next section/footer boundary.
    const m = text.match(
      /Maintenance ticket description\s+(.*?)\s*(?:Final Checklist|Smart Home|Access & Keys|HVAC & Air Filters|Utilities|ResiHome\s*[—–-]|Page \d+ of \d+|$)/i,
    );
    if (m) description = (m[1] || '').trim();
  }
  return { wanted, description };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const apply = String(req.query.apply || '') === '1';
  const startIdx = Math.max(0, Number(req.query.after) || 0);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const deadline = Date.now() + 250_000;

  try {
    const all = await fetchInspections();
    const targets = all.filter((i) =>
      TEMPLATES.has(i.templateType) && (i.status || '').toLowerCase() === 'completed');

    let processed = 0, wrote = 0, skippedExisting = 0, skippedNotFail = 0,
      skippedNoPdf = 0, parseErrors = 0, errors = 0;
    const changes: Array<{ id: string; address: string; wanted: string; hasDescription: boolean }> = [];
    const errorSamples: string[] = [];
    let i = startIdx;
    for (; i < targets.length && i < startIdx + limit; i++) {
      const insp = targets[i];
      processed++;
      try {
        // Only failed inspections ever showed the ticket widget.
        const props = await readInspectionProps(insp.recordId, ['inspection_result']);
        if ((props?.inspection_result || '').toLowerCase() !== 'fail') { skippedNotFail++; continue; }

        // Idempotent: skip if the synthetic answer is already present, and grab
        // the Review/Sign-Off section name so the new answer lands in that group.
        const existing = await fetchAnswersForInspection(insp.recordId);
        if (existing.some((a) => a.questionIdExternal === 'maint_ticket_request')) { skippedExisting++; continue; }
        const summarySection =
          existing.find((a) => /review|sign.?off|summary/i.test(a.section || ''))?.section
          || 'Review & Sign-Off';

        if (!insp.pdfUrl) { skippedNoPdf++; continue; }

        // Read the PDF to recover the Yes/No + description. On a fetch/parse
        // failure we SKIP (count as parseError) rather than writing a wrong
        // value — a transient failure must be retryable on a re-run, not
        // permanently mismark a real ticket as "No". A SUCCESSFUL parse with no
        // "Yes — Created" legitimately means no ticket → 'No' (per "if no value,
        // assume create-ticket = No").
        let wanted: 'Yes' | 'No';
        let description: string;
        try {
          const resp = await fetch(insp.pdfUrl);
          if (!resp.ok) throw new Error(`pdf fetch HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const text = await extractPdfText(buf);
          ({ wanted, description } = parseMaintTicket(text));
        } catch (pdfErr: any) {
          parseErrors++;
          if (errorSamples.length < 8) errorSamples.push(`${insp.recordId}: ${String(pdfErr?.message || pdfErr).slice(0, 160)}`);
          continue;
        }

        changes.push({ id: insp.recordId, address: insp.propertyAddressSnapshot, wanted, hasDescription: !!description });

        if (apply) {
          const eid = (qid: string) => `${insp.inspectionIdExternal}_${qid}__${SUMMARY_KEY}`;
          const upserts: Array<{ answerProps: Record<string, any> }> = [{
            answerProps: buildQaAnswerProps({
              answerIdExternal: eid('maint_ticket_request'),
              inspectionIdExternal: insp.inspectionIdExternal,
              questionIdExternal: 'maint_ticket_request',
              questionText: Q_REQUEST,
              section: summarySection,
              summaryInstanceLabel: SUMMARY_KEY,
              answerValue: wanted,
              location: null,
            }, { isScope: false }),
          }];
          if (wanted === 'Yes' && description) {
            upserts.push({
              answerProps: buildQaAnswerProps({
                answerIdExternal: eid('maint_ticket_description'),
                inspectionIdExternal: insp.inspectionIdExternal,
                questionIdExternal: 'maint_ticket_description',
                questionText: Q_DESCRIPTION,
                section: summarySection,
                summaryInstanceLabel: SUMMARY_KEY,
                answerValue: description,
                location: null,
              }, { isScope: false }),
            });
          }
          const results = await upsertAnswers(insp.recordId, upserts);
          if (results.some((r) => r.failed)) errors++; else wrote++;
        } else {
          wrote++; // would-write count in dry-run
        }
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 8) errorSamples.push(`${insp.recordId}: ${String(e?.message || e).slice(0, 160)}`);
        console.error(`[backfill-maint-ticket] ${insp.recordId} failed:`, String(e?.message || e).slice(0, 200));
      }
      if (Date.now() > deadline) { i++; break; }
    }

    const done = i >= targets.length;
    const nextAfter = done ? null : i;
    return res.status(200).json({
      ok: true,
      mode: apply ? 'apply' : 'dry-run (add ?apply=1 to write)',
      totalTargets: targets.length,
      processed,
      [apply ? 'wrote' : 'wouldWrite']: wrote,
      skippedExisting, skippedNotFail, skippedNoPdf, parseErrors, errors,
      done,
      nextAfter,
      resume: nextAfter != null
        ? `/api/admin/backfill-maint-ticket-answers?after=${nextAfter}&limit=${limit}${apply ? '&apply=1' : ''}`
        : null,
      sample: changes.slice(0, 25),
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-maint-ticket] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
