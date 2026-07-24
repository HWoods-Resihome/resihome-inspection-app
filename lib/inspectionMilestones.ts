/**
 * Inspection-count milestone celebrations.
 *
 * When an inspection is COMPLETED, if that completion pushes the portal's total
 * completed-inspection count across a milestone (1,000 / 2,500 / 5,000 / 10,000)
 * for the first time, email the inspector who logged it a celebration + secret
 * prize (see lib/notifications/milestone1k). Fires ONCE per milestone, ever.
 *
 * Once-only guard: each milestone is "claimed" by writing a Vercel Blob with
 * allowOverwrite:false — the write throws if the blob already exists, giving an
 * atomic claim across concurrent completions / instances. If the email then
 * fails, the claim is deleted so a later completion retries.
 *
 * Best-effort: every path is wrapped so a milestone check can NEVER break or slow
 * the completion flow into failure — it only logs.
 */
import { put, head, del } from '@vercel/blob';
import { countCompletedInspections, findNthCompletedInspection } from '@/lib/hubspot';
import { sendMilestoneEmail } from '@/lib/notifications/milestone1k';

export const INSPECTION_MILESTONES = [1000, 2500, 5000, 10000];

const claimKey = (m: number) => `milestones/inspections/${m}.json`;

/** Has this milestone already been claimed (celebrated)? */
async function milestoneClaimed(m: number): Promise<boolean> {
  try { await head(claimKey(m)); return true; }   // head throws if it doesn't exist
  catch { return false; }
}

/** Atomically claim a milestone. Returns true only for the FIRST caller. */
async function claimMilestone(m: number, meta: Record<string, any>): Promise<boolean> {
  try {
    await put(claimKey(m), JSON.stringify({ milestone: m, at: new Date().toISOString(), ...meta }),
      { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false });
    return true;
  } catch { return false; }   // already exists (someone else claimed) or store error
}

/** Release a claim so a later run retries (send failed / winner unresolved). */
async function releaseClaim(m: number): Promise<void> {
  try { await del(claimKey(m)); } catch { /* leave claimed; better a missed email than a dupe loop */ }
}

/**
 * Celebrate ONE reached milestone: atomically claim it, resolve the inspector who
 * logged the actual Nth completed inspection (in completion order — NOT whoever's
 * completion happened to trigger the check, so the right person is always
 * credited), and email them. Rolls the claim back if the winner can't be resolved
 * yet (e.g. the Nth record isn't search-indexed for a few seconds after it's
 * written) or the send fails, so a later completion / the cron backstop retries.
 */
async function celebrateMilestone(m: number, total: number): Promise<'sent' | 'skipped' | 'unresolved' | 'failed'> {
  if (!(await claimMilestone(m, { via: 'auto', total }))) return 'skipped';   // someone else got it
  const nth = await findNthCompletedInspection(m);
  const email = String(nth?.inspectorEmail || '').trim();
  if (!nth || !email) {
    console.warn(`[milestone] ${m} reached but the ${m}th inspection isn't resolvable yet (indexing lag / no inspector) — releasing claim to retry.`);
    await releaseClaim(m);
    return 'unresolved';
  }
  const r = await sendMilestoneEmail(email, { count: m, recipientName: nth.inspectorName });
  if (r.sent) { console.log(`[milestone] ${m} celebrated → ${email} (inspection ${nth.id}, total ${total})`); return 'sent'; }
  console.warn(`[milestone] ${m} send failed (${r.error}); releasing claim to retry.`);
  await releaseClaim(m);
  return 'failed';
}

/**
 * Check whether the portal has crossed any un-celebrated milestone and, if so,
 * celebrate it. Safe to call from either trigger:
 *   • right after an inspection is marked completed (the live path), and
 *   • the 30-min Insights rebuild cron (a backstop, so a crossing missed by the
 *     live path — indexing lag, a completion during downtime, or the threshold
 *     passing before this feature shipped — is still caught within 30 minutes).
 * Idempotent + once-only via the blob claim; never throws (only logs).
 */
export async function runInspectionMilestoneCheck(): Promise<void> {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return;   // no claim store → skip (never spams)
    // Cheapest possible pre-check: only touch HubSpot if SOME milestone is still
    // unclaimed (once all are done this is a few blob HEADs and out).
    const unclaimed: number[] = [];
    for (const m of INSPECTION_MILESTONES) if (!(await milestoneClaimed(m))) unclaimed.push(m);
    if (!unclaimed.length) return;

    const total = await countCompletedInspections();   // throws → caught below (skip)
    const due = unclaimed.filter((m) => total >= m).sort((a, b) => a - b);
    for (const m of due) await celebrateMilestone(m, total);
  } catch (e) {
    console.warn('[milestone] check skipped:', String((e as any)?.message || e).slice(0, 160));
  }
}

/**
 * Completion-path hook: call (awaited, never throws) right after an inspection is
 * marked completed. The inspectionId is no longer needed to pick the recipient —
 * the winner is resolved as the actual Nth completed inspection — but the param is
 * kept so existing call sites are unchanged.
 */
export async function celebrateInspectionMilestoneIfHit(_inspectionId?: string): Promise<void> {
  return runInspectionMilestoneCheck();
}

export interface MilestoneResendReport {
  milestone: number;
  total: number;                 // current completed count
  reached: boolean;              // total >= milestone
  claimed: boolean;              // milestone already celebrated (blob exists)
  inspection: Awaited<ReturnType<typeof findNthCompletedInspection>>;   // the Nth completed inspection + inspector
  action: 'dry-run' | 'sent' | 'already-claimed' | 'not-reached' | 'not-found' | 'no-inspector' | 'send-failed';
  error?: string;
}

/**
 * Identify the inspection whose completion hit a milestone (the Nth completed
 * inspection, in completion order) and — on apply — email that inspector the
 * celebration, recording the once-only claim so the live path won't double-send.
 * `force` re-sends even if the milestone was already claimed (stuck claim / manual
 * resend). Dry-run identifies without sending. Admin-triggered.
 */
export async function resendInspectionMilestone(
  milestone: number, opts: { apply: boolean; force?: boolean } = { apply: false },
): Promise<MilestoneResendReport> {
  const m = milestone;
  const base = { milestone: m, total: 0, reached: false, claimed: false, inspection: null } as MilestoneResendReport;
  if (!INSPECTION_MILESTONES.includes(m)) return { ...base, action: 'not-found', error: `Unknown milestone ${m}. Valid: ${INSPECTION_MILESTONES.join(', ')}` };

  const total = await countCompletedInspections();
  const claimed = await milestoneClaimed(m);
  if (total < m) return { ...base, total, claimed, action: 'not-reached' };

  const inspection = await findNthCompletedInspection(m);
  if (!inspection) return { ...base, total, reached: true, claimed, action: 'not-found', error: `Could not locate the ${m}th completed inspection (records with a completion timestamp: fewer than ${m}).` };
  const report: MilestoneResendReport = { milestone: m, total, reached: true, claimed, inspection, action: 'dry-run' };

  if (!opts.apply) return report;
  if (claimed && !opts.force) return { ...report, action: 'already-claimed' };
  if (!inspection.inspectorEmail) return { ...report, action: 'no-inspector', error: `Inspection ${inspection.id} has no inspector_email.` };

  const r = await sendMilestoneEmail(inspection.inspectorEmail, { count: m, recipientName: inspection.inspectorName });
  if (!r.sent) return { ...report, action: 'send-failed', error: r.error };
  // Record the claim (overwrite so a forced resend refreshes who it credited) so
  // the live completion path never sends this milestone again.
  try {
    await put(claimKey(m), JSON.stringify({ milestone: m, at: new Date().toISOString(), inspectionId: inspection.id, email: inspection.inspectorEmail, total, resent: true }),
      { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
  } catch (e) { console.warn('[milestone] resend claim write failed (email already sent):', e); }
  return { ...report, claimed: true, action: 'sent' };
}
