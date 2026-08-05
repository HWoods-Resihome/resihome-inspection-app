/**
 * lib/listingPhotosFailAlert.ts — when a 1099 Leasing Agent inspection is
 * submitted with the "Listing Photos Accurate?" question marked
 * "Fail - Needs Attention", post a Slack alert so the listings team can fix the
 * photos. Mirrors the PPW grass/pool fail card (pink accent, View Report +
 * Leave Note on Property buttons, inspector note, photos threaded) — but ROUTES
 * to the per-POD PASS ("move-in ready" / listings) channel set the turn/RRQC
 * alerts use, keyed by the property's region.
 *
 * The inspector is forced to attach at least one photo AND a note on that answer
 * before submit (the form's photo_required_on_values + note_required_on_values on
 * the question), so the card always carries the evidence.
 *
 * On/off + sandbox routing come from the admin "Slack Notifications" table (key
 * 'listing_photos_fail'). Gated per inspection (listing_photos_fail_alert_at) so a
 * re-submit won't re-post. Best-effort throughout — never blocks the submission.
 */
import {
  getPpwFailAlertStamp, stampPpwFailAlert, resolveInspectionPropertyId,
  readInspectionProps, type SavedAnswer,
} from '@/lib/hubspot';
import { postSlackMessage } from '@/lib/slack';
import { resolveSlackTarget } from '@/lib/slackNotifications';
import { buildFailAttachment, type FailNoteCtx } from '@/lib/slackFailAlerts';
import { PASS_CHANNELS, podForRegion } from '@/lib/reinspectAlertsConfig';

// Own stamp property so a listing-photos alert and a grass/pool alert on the SAME
// inspection don't gate each other.
const LISTING_STAMP_PROP = 'listing_photos_fail_alert_at';
// Optional hard override — when set, ALWAYS post here instead of region→PASS.
const CHANNEL_OVERRIDE = (process.env.SLACK_LISTING_PHOTOS_FAIL_CHANNEL || '').trim();
// Where to post when the region maps to no POD PASS channel (so an unroutable
// region never silently drops the alert). Defaults to the PPW fails channel.
const FALLBACK_CHANNEL = (process.env.SLACK_LISTING_PHOTOS_FAIL_FALLBACK || process.env.SLACK_PPW_FAILS_CHANNEL || '#1099-agent-ppw-fails').trim();
// Optional Slack user IDs @-mentioned on each alert (comma-separated).
const ALERT_MENTIONS = (process.env.SLACK_LISTING_PHOTOS_FAIL_MENTIONS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Match the listing-photos question by text carried in each answer's summary.
const LISTING_PHOTOS_RE = /listing photos/i;
// A failing response — "Fail - Needs Attention" (vs "Good - No Issues").
const FAIL_RE = /\bfail(ed|ing)?\b|needs attention|poor|deficient/i;

export interface ListingPhotosFailInspectionRef {
  recordId: string;
  propertyAddressSnapshot: string;
  inspectorName?: string;
  propertyRecordId?: string | null;
  /** region_snapshot when the caller has it — else resolved server-side. */
  region?: string | null;
}

export function findListingPhotosAnswer(answers: SavedAnswer[]): SavedAnswer | undefined {
  return answers
    .filter((a) => (a.answerType || 'qa') === 'qa')
    .find((a) => LISTING_PHOTOS_RE.test(a.answerSummary || ''));
}

export function isListingPhotosFail(a: SavedAnswer | undefined): boolean {
  if (!a) return false;
  return FAIL_RE.test((a.answerValue || '').trim());
}

export async function postListingPhotosFailAlertOnSubmit(
  inspection: ListingPhotosFailInspectionRef,
  answers: SavedAnswer[],
  opts?: { baseUrl?: string },
): Promise<{ posted: boolean; reason?: string; channel?: string; error?: string }> {
  // 1) Trigger: the listing-photos answer marked Fail - Needs Attention.
  const ans = findListingPhotosAnswer(answers);
  if (!ans) return { posted: false, reason: 'no listing-photos answer' };
  if (!isListingPhotosFail(ans)) return { posted: false, reason: `not a fail (${(ans.answerValue || '').trim() || 'blank'})` };

  // 2) Route: hard override, else region → POD → PASS channel, else fallback.
  let region = (inspection.region || '').trim();
  if (!region && !CHANNEL_OVERRIDE) {
    const props = await readInspectionProps(inspection.recordId, ['region_snapshot']).catch(() => null);
    region = String(props?.region_snapshot || '').trim();
  }
  const pod = podForRegion(region);
  const intendedChannel = CHANNEL_OVERRIDE || (pod ? PASS_CHANNELS[pod] : FALLBACK_CHANNEL);

  // 3) Admin gate: on/off + sandbox routing from the Slack Notifications table.
  const target = await resolveSlackTarget('listing_photos_fail', intendedChannel);
  if (!target.enabled) return { posted: false, reason: 'disabled' };
  const channel = target.channel;
  const GATE_ACTIVE = !target.sandbox; // sandbox re-posts freely; production posts once
  if (GATE_ACTIVE) {
    const stamp = await getPpwFailAlertStamp(inspection.recordId, LISTING_STAMP_PROP);
    if (stamp) return { posted: false, reason: 'gated (already posted)' };
  }

  // 4) Resolve the property (for the "Leave Note" write) + build the PINK card.
  const base = (opts?.baseUrl || 'https://resiwalk.com').replace(/\/+$/, '');
  const inspectionUrl = `${base}/inspection/${inspection.recordId}`;
  const address = (inspection.propertyAddressSnapshot || '').trim() || '(address n/a)';
  const response = (ans.answerValue || '').trim() || 'Fail - Needs Attention';
  const note = (ans.note || '').trim();
  const photos = (ans.photoUrls || []).filter(Boolean);
  const propertyId = (inspection.propertyRecordId || '').trim()
    || (await resolveInspectionPropertyId(inspection.recordId).catch(() => null)) || '';

  const ctx: FailNoteCtx = {
    reviewType: 'Listing', inspectionId: inspection.recordId, propertyId,
    address, inspector: inspection.inspectorName || '', response,
    inspectorNote: note, openUrl: inspectionUrl, photosCount: photos.length,
  };
  const text = `Listing photos need attention — ${address}`;
  const attachments = buildFailAttachment(ctx);
  if (ALERT_MENTIONS.length) {
    attachments[0].blocks.unshift({ type: 'section', text: { type: 'mrkdwn', text: ALERT_MENTIONS.map((u) => `<@${u}>`).join(' ') } });
  }

  // 5) Post the parent; stamp on success; thread the photo links.
  const res = await postSlackMessage(channel, { text, attachments });
  if (res.ok) {
    if (GATE_ACTIVE) await stampPpwFailAlert(inspection.recordId, LISTING_STAMP_PROP, 'Listing-Photos Fail Alert Posted At');
    if (res.ts && photos.length) {
      const links = photos.slice(0, 12).map((u, i) => `<${u}|Photo ${i + 1} ↗>`).join('   ·   ');
      const replyBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*Listing photos*\n${links}` } }];
      const reply = await postSlackMessage(channel, { text: `${photos.length} listing photos for ${address}`, blocks: replyBlocks, thread_ts: res.ts });
      if (!reply.ok) console.warn(`[listing-photos-fail] ${inspection.recordId}: photo thread reply failed: ${reply.error}`);
    }
    console.log(`[listing-photos-fail] ${inspection.recordId}: posted to ${res.channel} (region ${region || 'UNKNOWN'} → ${pod || 'fallback'}, ${photos.length} photos)`);
    return { posted: true, channel: res.channel };
  }
  console.warn(`[listing-photos-fail] ${inspection.recordId}: Slack post failed: ${res.error}`);
  return { posted: false, reason: 'slack post failed', error: res.error, channel };
}
