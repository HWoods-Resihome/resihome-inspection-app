/**
 * lib/poolFailAlert.ts — when a 1099 Leasing Agent inspection is submitted with
 * the Final Checklist "Pool Condition" marked FAIL, post the PINK PPW-dispatch
 * card (with a montage of the pool photos + the "Leave Note on Property" action)
 * so the Recurring Team can dispatch and leave a note.
 *
 * This ports the prior HubSpot custom-code action into ResiWalk so pool fails
 * fire from the app like every other notification. The button click is handled
 * by the SHARED Slack interactivity handler (v0-resihome/api/interactivity) —
 * the SAME one grass uses — via the shared `reviewType: 'Grass/Pool'` contract.
 *
 * On/off + sandbox routing: admin "Slack Notifications" table, key 'ppw_pool_fail'.
 * Gated per inspection on its OWN stamp (ppw_pool_fail_alert_at) so it doesn't
 * collide with the grass gate. Best-effort — never blocks the submission.
 */
import {
  getPpwFailAlertStamp, stampPpwFailAlert, resolveInspectionPropertyId,
  PPW_POOL_FAIL_ALERT_PROP,
} from '@/lib/hubspot';
import { postSlackMessage } from '@/lib/slack';
import { resolveSlackTarget } from '@/lib/slackNotifications';
import { buildFailAttachment, type FailNoteCtx } from '@/lib/slackFailAlerts';

// Live destination (override via env). The prior pool action posted to C0BBHHQSRQT.
const LIVE_CHANNEL = (process.env.SLACK_PPW_POOL_FAILS_CHANNEL || 'C0BBHHQSRQT').trim();
// @-mentions on each alert (falls back to the shared PPW mentions env).
const TAG_USERS = (process.env.SLACK_PPW_POOL_MENTIONS || process.env.SLACK_PPW_FAILS_MENTIONS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// A failing pool response: "Fail" / "Fail - Needs Attention" / "Poor" / etc.
const FAIL_RE = /\bfail(ed|ing)?\b|needs attention|poor|deficient/i;

export interface PoolFailInspectionRef {
  recordId: string;
  propertyAddressSnapshot: string;
  inspectorName?: string;
  propertyRecordId?: string | null;
}
export interface PoolStamps { poolCondition: string; poolFeedback: string; poolPhotoUrls: string }

export async function postPoolFailAlertOnSubmit(
  inspection: PoolFailInspectionRef,
  pool: PoolStamps,
  opts?: { baseUrl?: string },
): Promise<{ posted: boolean; reason?: string; channel?: string; error?: string }> {
  // 1) Trigger: pool condition marked Fail.
  const condition = (pool.poolCondition || '').trim();
  if (!condition) return { posted: false, reason: 'no pool answer' };
  if (!FAIL_RE.test(condition)) return { posted: false, reason: `not a fail (${condition})` };

  // 2) Admin gate: on/off + sandbox routing from the Slack Notifications table.
  const target = await resolveSlackTarget('ppw_pool_fail', LIVE_CHANNEL);
  if (!target.enabled) return { posted: false, reason: 'disabled' };
  const channel = target.channel;
  const GATE_ACTIVE = !target.sandbox; // sandbox re-posts freely; production posts once
  if (GATE_ACTIVE) {
    const stamp = await getPpwFailAlertStamp(inspection.recordId, PPW_POOL_FAIL_ALERT_PROP);
    if (stamp) return { posted: false, reason: 'gated (already posted)' };
  }

  // 3) Build the PINK pool card (montage strip + Leave Note button).
  const base = (opts?.baseUrl || 'https://resiwalk.com').replace(/\/+$/, '');
  const inspectionUrl = `${base}/inspection/${inspection.recordId}`;
  const address = (inspection.propertyAddressSnapshot || '').trim() || '(address n/a)';
  const photos = (pool.poolPhotoUrls || '').split(/[\n;,]/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  const propertyId = (inspection.propertyRecordId || '').trim()
    || (await resolveInspectionPropertyId(inspection.recordId).catch(() => null)) || '';

  const ctx: FailNoteCtx = {
    reviewType: 'Pool', inspectionId: inspection.recordId, propertyId,
    address, inspector: inspection.inspectorName || '', response: condition,
    inspectorNote: (pool.poolFeedback || '').trim(), openUrl: inspectionUrl,
    photos, photosCount: photos.length, mentions: TAG_USERS,
  };
  const text = `Pool fail — ${address} (dispatch PPW)`;
  const attachments = buildFailAttachment(ctx);

  // 4) Post; stamp on success; thread the raw photo links (montage is in-card).
  const res = await postSlackMessage(channel, { text, attachments });
  if (res.ok) {
    if (GATE_ACTIVE) await stampPpwFailAlert(inspection.recordId, PPW_POOL_FAIL_ALERT_PROP, 'PPW Pool-Fail Alert Posted At');
    if (res.ts && photos.length) {
      const links = photos.slice(0, 12).map((u, i) => `<${u}|Photo ${i + 1} ↗>`).join('   ·   ');
      const reply = await postSlackMessage(channel, { text: `${photos.length} pool photos for ${address}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Pool photos*\n${links}` } }], thread_ts: res.ts });
      if (!reply.ok) console.warn(`[ppw-pool-fail] ${inspection.recordId}: photo thread reply failed: ${reply.error}`);
    }
    console.log(`[ppw-pool-fail] ${inspection.recordId}: posted to ${res.channel} (${condition}, ${photos.length} photos)`);
    return { posted: true, channel: res.channel };
  }
  console.warn(`[ppw-pool-fail] ${inspection.recordId}: Slack post failed: ${res.error}`);
  return { posted: false, reason: 'slack post failed', error: res.error, channel };
}
