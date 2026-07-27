/**
 * GET /api/cron/completion-email-backstop — the "always happens" guarantee for the
 * QuestionForm-type completion email.
 *
 * That email is sent from /api/pdf on completion, which depends on the CLIENT
 * calling /api/pdf and on a HubSpot read succeeding. If the inspector loses signal
 * or closes the app right after finishing, the email can silently never send. This
 * sweep catches recently-completed inspections that have a report PDF but no
 * `completion_emailed_at` stamp and sends the completion email (then stamps it, so
 * it's sent exactly once).
 *
 * Scope: EXCLUDES pm_scope_rate_card (emails its damages report at finalize) and
 * pm_turn_reinspect_qc (emails from qc-finalize) — those own their own email and
 * never set completion_emailed_at. Window-bounded to recent completions so it can
 * never retro-email historical inspections that predate the stamp.
 *
 * Auth: Vercel Cron (CRON_SECRET bearer / ?key=) OR an app-admin session
 * (?dryRun=1 to preview the gap list without sending).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  searchInspectionsMissingProp, readInspectionProps, updateInspection,
  fetchInspectionById, fetchPropertyCommunityRrqcWalkEmail, ensureCompletionEmailedProperty,
} from '@/lib/hubspot';
import { notifyInspectionCompleted } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';
import { templateLabel } from '@/lib/templateLabels';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';

export const config = { maxDuration: 120 };

const COMPLETED_STATUSES = ['completed', 'complete', 'submitted', 'Completed'];
const WINDOW_MS = 48 * 3600_000;               // recent completions only — never retro-email history
const MAX_PER_RUN = 25;
// Templates that email via their OWN route (not /api/pdf) — never backstop them.
const OWN_EMAIL_TEMPLATES = new Set(['pm_scope_rate_card', 'pm_turn_reinspect_qc']);

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

  // The dedupe property must exist before we can filter on NOT_HAS_PROPERTY.
  const propOk = await ensureCompletionEmailedProperty().catch(() => false);
  if (!propOk) return res.status(200).json({ ok: false, error: 'completion_emailed_at property unavailable (schema write scope?)' });

  // Sending is OPT-IN via COMPLETION_EMAIL_BACKSTOP_SINCE (ISO). Only completions
  // at/after that timestamp are eligible to send — so enabling it can never
  // retro-email inspections that were already emailed under the old logic (which
  // never set the stamp). Unset → the cron reports the gap but sends nothing.
  const sinceEnv = (process.env.COMPLETION_EMAIL_BACKSTOP_SINCE || '').trim();
  const sinceEnvMs = sinceEnv ? Date.parse(sinceEnv) : NaN;
  const sendEnabled = !dryRun && !!sinceEnv && !isNaN(sinceEnvMs);

  const sinceMs = Date.now() - WINDOW_MS;
  let candidates: { id: string; props: Record<string, any> }[] = [];
  try {
    candidates = await searchInspectionsMissingProp({
      statusValues: COMPLETED_STATUSES,
      missingProp: 'completion_emailed_at',   // never emailed
      requireProp: 'pdf_attachment_url',      // report exists (so we can attach/link)
      sinceProp: 'completed_at',
      sinceMs,
      props: ['template_type', 'inspector_email', 'property_address_snapshot', 'inspection_name', 'property_id_ref', 'completed_at'],
      limit: MAX_PER_RUN,
    });
  } catch (e: any) {
    return res.status(500).json({ error: `candidate search failed: ${String(e?.message || e)}` });
  }

  const eligible = candidates.filter((c) => !OWN_EMAIL_TEMPLATES.has(String(c.props.template_type || '')));

  if (dryRun || !sendEnabled) {
    return res.status(200).json({
      dryRun, sendEnabled, windowHours: WINDOW_MS / 3600_000,
      found: candidates.length, eligible: eligible.length,
      note: sendEnabled ? undefined : 'Reporting only — set COMPLETION_EMAIL_BACKSTOP_SINCE=<ISO> to enable sending for completions at/after that time.',
      list: eligible.map((c) => ({ id: c.id, template: c.props.template_type, address: c.props.property_address_snapshot })),
    });
  }

  const parseMs = (raw: any): number => {
    const s = String(raw || '').trim(); if (!s) return 0;
    if (/^\d+$/.test(s)) return Number(s);
    const t = Date.parse(s); return isNaN(t) ? 0 : t;
  };
  const base = appBaseUrl(req);
  let sent = 0; let skippedPreCutover = 0; const errors: { id: string; error: string }[] = [];
  for (const c of eligible) {
    try {
      // Only send for completions at/after the configured cutover — never
      // retro-email older ones that predate the stamp mechanism.
      if (parseMs(c.props.completed_at) < sinceEnvMs) { skippedPreCutover++; continue; }
      // Re-read right before sending to dedupe a race with /api/pdf on another
      // instance (it may have just sent + stamped).
      const fresh = await readInspectionProps(c.id, ['completion_emailed_at']).catch(() => null);
      if (fresh && String(fresh.completion_emailed_at || '').trim()) continue;

      const insp = await fetchInspectionById(c.id);
      if (!insp) continue;
      let extraTo: string[] = [];
      if ((insp.templateType || '') === 'qc_new_construction_rrqc' && insp.propertyRecordId) {
        const walk = await fetchPropertyCommunityRrqcWalkEmail(insp.propertyRecordId).catch(() => null);
        if (walk) extraTo = [walk];
      }
      await notifyInspectionCompleted({
        inspectionId: c.id,
        inspectorEmail: insp.inspectorEmail,
        templateLabel: templateLabel(insp.templateType),
        address: insp.propertyAddressSnapshot || insp.inspectionName || 'the property',
        pdfUrl: insp.pdfUrl || undefined,
        baseUrl: base,
        extraTo,
      });
      await updateInspection(c.id, { completion_emailed_at: new Date().toISOString() }).catch(() => {});
      sent++;
    } catch (e: any) {
      errors.push({ id: c.id, error: String(e?.message || e).slice(0, 160) });
    }
  }

  return res.status(200).json({ ok: true, windowHours: WINDOW_MS / 3600_000, found: candidates.length, eligible: eligible.length, sent, skippedPreCutover, errors });
}
