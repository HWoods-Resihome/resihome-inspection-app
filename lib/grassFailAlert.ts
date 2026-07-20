/**
 * lib/grassFailAlert.ts — when a 1099 Leasing Agent inspection is submitted with
 * the grass / landscaping question marked as a FAIL, post a Slack alert to the
 * PPW-dispatch channel ("1099-agent-ppw-fails") so grass can be scheduled:
 *   1) names the property + inspector,
 *   2) shows the grass response + the inspector's required note,
 *   3) links to the inspection (photos live there) and threads the photo links.
 *
 * Channel via SLACK_PPW_FAILS_CHANNEL (defaults to the #1099-agent-ppw-fails
 * channel by name; set to the channel ID for reliability). On/off + sandbox
 * routing come from the admin "Slack Notifications" table (key 'ppw_grass_fail').
 * Gated per inspection so a re-submit won't re-post. Best-effort throughout —
 * never blocks the submission.
 */
import {
  getPpwFailAlertStamp, stampPpwFailAlert, resolveInspectionPropertyId, type SavedAnswer,
} from '@/lib/hubspot';
import { postSlackMessage } from '@/lib/slack';
import { resolveSlackTarget } from '@/lib/slackNotifications';
import { buildFailAttachment, type FailNoteCtx } from '@/lib/slackFailAlerts';

// Live destination (override via SLACK_PPW_FAILS_CHANNEL). A channel NAME works
// with chat.postMessage as long as the bot is a member; prefer the ID in prod.
const LIVE_CHANNEL = (process.env.SLACK_PPW_FAILS_CHANNEL || '#1099-agent-ppw-fails').trim();
// Optional Slack user IDs @-mentioned on each alert (comma-separated).
const ALERT_MENTIONS = (process.env.SLACK_PPW_FAILS_MENTIONS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Match the grass question by text carried in each answer's summary. Broad on
// purpose — "Grass Condition", "Landscape / Trees / Grass", "Lawn / Grass", etc.
// all match, so a form-builder rename can't silently starve this notification.
const GRASS_RE = /grass|landscap|lawn/i;
// A failing response. 1099 questions use "Fail - Needs Attention" (vs "Good - No
// Issues" / "N/A"); also tolerate plain "Fail" / "Poor" / "Deficient".
const FAIL_RE = /\bfail(ed|ing)?\b|needs attention|poor|deficient/i;

export interface GrassFailInspectionRef {
  recordId: string;
  propertyAddressSnapshot: string;
  inspectorName?: string;
  /** property_id_ref, when the caller already has it — else resolved server-side
   *  so the "Leave Note on Property" action can write the note. */
  propertyRecordId?: string | null;
}

export function findGrassAnswer(answers: SavedAnswer[]): SavedAnswer | undefined {
  return answers
    .filter((a) => (a.answerType || 'qa') === 'qa')
    .find((a) => GRASS_RE.test(a.answerSummary || ''));
}

export function isGrassFail(a: SavedAnswer | undefined): boolean {
  if (!a) return false;
  return FAIL_RE.test((a.answerValue || '').trim());
}

export async function postGrassFailAlertOnSubmit(
  inspection: GrassFailInspectionRef,
  answers: SavedAnswer[],
  opts?: { baseUrl?: string },
): Promise<{ posted: boolean; reason?: string; channel?: string; error?: string }> {
  // 1) Trigger: a grass/landscaping answer with a failing response.
  const ans = findGrassAnswer(answers);
  if (!ans) return { posted: false, reason: 'no grass answer' };
  if (!isGrassFail(ans)) return { posted: false, reason: `not a fail (${(ans.answerValue || '').trim() || 'blank'})` };

  // 2) Admin gate: on/off + sandbox routing from the Slack Notifications table.
  const target = await resolveSlackTarget('ppw_grass_fail', LIVE_CHANNEL);
  if (!target.enabled) return { posted: false, reason: 'disabled' };
  const channel = target.channel;
  const GATE_ACTIVE = !target.sandbox; // sandbox re-posts freely; production posts once
  if (GATE_ACTIVE) {
    const stamp = await getPpwFailAlertStamp(inspection.recordId);
    if (stamp) return { posted: false, reason: 'gated (already posted)' };
  }

  // 3) Resolve the property (for the "Leave Note" write) + build the PINK card.
  const base = (opts?.baseUrl || 'https://resiwalk.com').replace(/\/+$/, '');
  const inspectionUrl = `${base}/inspection/${inspection.recordId}`;
  const address = (inspection.propertyAddressSnapshot || '').trim() || '(address n/a)';
  const response = (ans.answerValue || '').trim() || 'Fail';
  const note = (ans.note || '').trim();
  const photos = (ans.photoUrls || []).filter(Boolean);
  const propertyId = (inspection.propertyRecordId || '').trim()
    || (await resolveInspectionPropertyId(inspection.recordId).catch(() => null)) || '';

  const ctx: FailNoteCtx = {
    reviewType: 'Grass', inspectionId: inspection.recordId, propertyId,
    address, inspector: inspection.inspectorName || '', response,
    inspectorNote: note, openUrl: inspectionUrl, photosCount: photos.length,
  };
  const text = `Grass fail — ${address} (dispatch PPW)`;
  const attachments = buildFailAttachment(ctx);
  // Optional @-mentions ride along as a leading line inside the pink card.
  if (ALERT_MENTIONS.length) {
    attachments[0].blocks.unshift({ type: 'section', text: { type: 'mrkdwn', text: ALERT_MENTIONS.map((u) => `<@${u}>`).join(' ') } });
  }

  // 4) Post the parent; stamp on success; thread the photo links (keeps parent compact).
  const res = await postSlackMessage(channel, { text, attachments });
  if (res.ok) {
    if (GATE_ACTIVE) await stampPpwFailAlert(inspection.recordId);
    if (res.ts && photos.length) {
      const links = photos.slice(0, 12).map((u, i) => `<${u}|Photo ${i + 1} ↗>`).join('   ·   ');
      const replyBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*Grass photos*\n${links}` } }];
      const reply = await postSlackMessage(channel, { text: `${photos.length} grass photos for ${address}`, blocks: replyBlocks, thread_ts: res.ts });
      if (!reply.ok) console.warn(`[ppw-fail-alert] ${inspection.recordId}: photo thread reply failed: ${reply.error}`);
    }
    console.log(`[ppw-fail-alert] ${inspection.recordId}: posted to ${res.channel} (${response}, ${photos.length} photos)`);
    return { posted: true, channel: res.channel };
  }
  console.warn(`[ppw-fail-alert] ${inspection.recordId}: Slack post failed: ${res.error}`);
  return { posted: false, reason: 'slack post failed', error: res.error, channel };
}
