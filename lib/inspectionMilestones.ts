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
import { countCompletedInspections, readInspectionProps } from '@/lib/hubspot';
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
