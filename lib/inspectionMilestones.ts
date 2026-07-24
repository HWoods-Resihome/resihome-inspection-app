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
import { countCompletedInspections, readInspectionProps, findNthCompletedInspection } from '@/lib/hubspot';
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

/**
 * Check whether completing this inspection crossed a milestone; if so, celebrate
 * the inspector. Call (awaited, but it never throws) right after an inspection is
 * marked completed. `inspectionId` is used to look up the inspector to email.
 */
export async function celebrateInspectionMilestoneIfHit(inspectionId: string): Promise<void> {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return;   // no claim store → skip (never spams)
    // Cheapest possible pre-check: only touch HubSpot if SOME milestone is still
    // unclaimed (once all are done this is a couple of blob HEADs and out).
    const unclaimedAll: number[] = [];
    for (const m of INSPECTION_MILESTONES) if (!(await milestoneClaimed(m))) unclaimedAll.push(m);
    if (!unclaimedAll.length) return;

    const total = await countCompletedInspections();   // throws → caught below (skip)
    const due = unclaimedAll.filter((m) => total >= m);
    if (!due.length) return;

    // Resolve the inspector who logged this milestone inspection.
    const props = await readInspectionProps(inspectionId, ['inspector_email', 'inspector_name']).catch(() => ({} as Record<string, any>));
    const email = String(props?.inspector_email || '').trim();
    const name = String(props?.inspector_name || '').trim();
    if (!email) { console.warn(`[milestone] hit ${due.join(',')} but inspection ${inspectionId} has no inspector_email — not sending.`); return; }

    for (const m of due) {
      // Claim first (atomic once-only), then send; roll the claim back on failure.
      if (!(await claimMilestone(m, { inspectionId, email, total }))) continue;   // someone else got it
      const r = await sendMilestoneEmail(email, { count: m, recipientName: name });
      if (r.sent) {
        console.log(`[milestone] ${m} celebrated → ${email} (inspection ${inspectionId}, total ${total})`);
      } else {
        console.warn(`[milestone] ${m} send failed (${r.error}); releasing claim to retry next completion.`);
        try { await del(claimKey(m)); } catch { /* leave claimed; better a missed email than a dupe loop */ }
      }
    }
  } catch (e) {
    console.warn('[milestone] check skipped:', String((e as any)?.message || e).slice(0, 160));
  }
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
