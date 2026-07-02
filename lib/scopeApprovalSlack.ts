/**
 * lib/scopeApprovalSlack.ts — Scope Rate Card approval Slack notifications,
 * ported 1:1 from the two HubSpot workflow custom-code actions (no deviation):
 *
 *   postScopePendingApproval(inspectionId)  — Workflow A ("Pending Approval"):
 *     region → POD channel → post the pending card (#ff0060 bar, buttons) →
 *     getPermalink → write back to the inspection's `slackmessagelink`. Deduped
 *     on an existing slackmessagelink.
 *
 *   postScopeApproved(inspectionId)         — Workflow B ("Completed"):
 *     parse channel+ts from slackmessagelink → threaded blue reply (approved
 *     by/at) → recolor the original card blue + APPROVED (chat.update).
 *
 * Channel routing, approver @mentions, colors, copy, and buttons are preserved
 * exactly. The only additions are (a) it runs in-app at the status transition
 * instead of a HubSpot workflow, and (b) the admin Slack-Notifications gate
 * (on/off + sandbox reroute) via resolveSlackTarget().
 */
import { fetchInspectionProperties, fetchPropertyRegion, writeInspectionSlackLink, readApprovalRouting } from '@/lib/hubspot';
import { slackCall, getSlackPermalink } from '@/lib/slack';
import { resolveSlackTarget } from '@/lib/slackNotifications';
import { resolveApprovers, type ApprovalRoutingConfig } from '@/lib/approvalRouting';

// ---- CONFIG (verbatim from the workflow code) -------------------------------
const PORTAL_ID = (process.env.HUBSPOT_PORTAL_ID || '22536354').trim();
const INSPECTION_OBJECT_TYPE = (process.env.HUBSPOT_INSPECTION_TYPE_ID || '2-63428834').trim();

// Region prefix → POD channel
const CHANNEL_GA = 'C08NEJYDW65'; // GA:
const CHANNEL_SE = 'C08LQCBGTD1'; // NC: SC: AL: TN: IN:
const CHANNEL_SW = 'C087UENA8RF'; // TX: AZ: OK:
const CHANNEL_FL = 'C06ET3QPYRY'; // FL:

// @mention of the regional approver, keyed by POD channel (raw id; wrapped below).
const POD_APPROVERS: Record<string, string> = {
  [CHANNEL_GA]: 'U03DRMPAA9Y', // Donald Gongaware  (GA)
  [CHANNEL_SE]: 'U0912JGHY1E', // Dori Herrington   (NC, SC, AL, TN, IN)
  [CHANNEL_SW]: 'U0368PN8FS8', // Jo Ann Haynes     (TX, AZ, OK)
  [CHANNEL_FL]: 'U0A867BRLQH', // Andrea McMillian  (FL)
};

const COLOR_PENDING = '#ff0060';
const COLOR_APPROVED = '#1D9BD1';

function money(v: any): string {
  if (v === '' || v == null) return '—';
  const n = Number(v);
  return isNaN(n) ? String(v) : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function channelForRegion(regionValue: string | null): string {
  const r = (regionValue || '').trim().toUpperCase();
  if (r.startsWith('GA:')) return CHANNEL_GA;
  if (r.startsWith('NC:') || r.startsWith('SC:') || r.startsWith('AL:') || r.startsWith('TN:') || r.startsWith('IN:')) return CHANNEL_SE;
  if (r.startsWith('TX:') || r.startsWith('AZ:') || r.startsWith('OK:')) return CHANNEL_SW;
  if (r.startsWith('FL:')) return CHANNEL_FL;
  return ''; // no region match → no channel; caller SKIPS the post (was the dead
             // sandbox channel, where the card went unseen).
}

// ============================ WORKFLOW A — PENDING ===========================
export async function postScopePendingApproval(inspectionId: string): Promise<{ status: string; channel?: string; permalink?: string; error?: string }> {
  const p = await fetchInspectionProperties(inspectionId, [
    'property_id_ref', 'inspection_name', 'inspector_name', 'property_address_snapshot',
    'pdf_master_url', 'resiwalk_inspection_url', 'total_client_cost', 'total_tenant_cost', 'slackmessagelink',
  ]);

  // Dedupe guard: already posted → do nothing (matches workflow).
  const existingLink = (p.slackmessagelink || '').toString().trim();
  if (existingLink) return { status: 'ALREADY_SENT', permalink: existingLink };

  const propertyRecordId = (p.property_id_ref || '').toString().trim();
  const inspectorName = (p.inspector_name || 'Unknown').toString();
  const propertyAddress = (p.property_address_snapshot || 'Address not provided').toString();
  const pdfUrl = (p.pdf_master_url || '').toString().trim();
  const resiwalkUrl = (p.resiwalk_inspection_url || '').toString().trim();
  const ratecardTotal = p.total_client_cost ?? '';
  const tenantTotal = p.total_tenant_cost ?? '';

  // 1) Region → who to tag + which channel. Phase 2: drive this from the
  // Approval Routing table (PODs → Regions → PM/Sr.PM/RM/Director with NTE
  // ceilings) via the SAME pure resolver the admin preview uses. The approver(s)
  // track the real region even when posting is sandbox-rerouted.
  const region = propertyRecordId ? await fetchPropertyRegion(propertyRecordId) : null;
  const amount = Number(ratecardTotal) || 0;
  let routing: ApprovalRoutingConfig | null = null;
  try { routing = await readApprovalRouting(); } catch (e) { console.warn('[scope-slack] approval routing read failed:', e); }
  const recip = routing ? resolveApprovers(routing, region || '', amount) : null;
  const mapped = !!(recip && recip.channelId); // region is mapped to a POD in the routing table

  // Channel: the POD's configured channel when mapped, else the legacy region-
  // prefix routing (so an unmapped region still lands somewhere sensible).
  const intendedChannel = (mapped ? recip!.channelId! : channelForRegion(region));
  // No channel resolves (region not in the routing table AND matches no prefix):
  // SKIP rather than post to a dead sandbox channel where nobody sees it. Logged
  // loudly so the unroutable region is visible and can be added to routing.
  if (!intendedChannel) {
    console.warn(`[scope-slack] no Slack channel for region "${region || '(blank)'}" — skipping pending-approval post for ${inspectionId}. Add the region to the Approval Routing table or a channel prefix.`);
    return { status: 'NO_CHANNEL', error: `Unroutable region: ${region || '(blank)'}` };
  }

  // The approver line: dynamic (total + tier tags / @channel) when the region is
  // mapped; otherwise the original hard-coded line as a safe fallback.
  let approverText: string;
  if (mapped) {
    const totalLine = `*This Scope has a completion total of ${money(amount)}.*`;
    if (recip!.level === 'pm') {
      approverText = `${totalLine}\nAny PM can approve — <!channel>`;
    } else {
      const mentions = recip!.users.map((u) => (u.slackId ? `<@${u.slackId}>` : u.name)).filter(Boolean).join(' ');
      const tierLabel = recip!.level === 'sr_pm' ? 'SR / AM' : recip!.level === 'rm' ? 'RM' : 'Director';
      approverText = `${totalLine}\nApproval required from ${mentions || '_no approver configured_'} (${tierLabel})`;
    }
  } else {
    const approverId = POD_APPROVERS[intendedChannel];
    const approverMention = approverId ? `<@${approverId}>` : 'your regional approver';
    approverText = `Exceeding $1,500 will require *APPROVAL* from ${approverMention}. Exceeding $5,000 will require approval from Director.`;
  }

  // Admin gate: on/off + sandbox reroute.
  const target = await resolveSlackTarget('scope_pending', intendedChannel);
  if (!target.enabled) return { status: 'DISABLED' };
  const channel = target.channel;

  const recordUrl = `https://app.hubspot.com/contacts/${PORTAL_ID}/record/${INSPECTION_OBJECT_TYPE}/${inspectionId}`;
  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Requesting a Scope review for:* ${propertyAddress}  |  *Submitted By:* ${inspectorName}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Ratecard Total:* ${money(ratecardTotal)}\n*Tenant Total:* ${money(tenantTotal)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: approverText } },
  ];
  if (pdfUrl) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*PDF — Master Report URL:* <${pdfUrl}|Open report>` } });
  const buttons: any[] = [{ type: 'button', text: { type: 'plain_text', text: 'View Inspection in HubSpot', emoji: true }, url: recordUrl }];
  if (resiwalkUrl) buttons.push({ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Review Inspection', emoji: true }, url: resiwalkUrl });
  blocks.push({ type: 'actions', elements: buttons });

  const post = await slackCall('chat.postMessage', {
    channel,
    text: `Scope Rate Card review needed: ${propertyAddress}`,
    attachments: [{ color: COLOR_PENDING, blocks }],
  });
  if (!post.ok) {
    console.error('[scope-slack] pending post failed:', post.error);
    return { status: 'POST_FAILED', channel, error: String(post.error) };
  }

  const messageTs = post.ts;
  const messageChannel = post.channel;
  let permalink = await getSlackPermalink(messageChannel, messageTs);
  if (!permalink) permalink = `https://resicap.slack.com/archives/${messageChannel}/p${String(messageTs).replace('.', '')}`;
  await writeInspectionSlackLink(inspectionId, permalink);

  console.log(`[scope-slack] pending posted for ${inspectionId} → ${messageChannel} (region ${region || 'UNKNOWN'}, ${mapped ? `routed:${recip!.level}` : 'unmapped-fallback'}${target.sandbox ? ', sandbox' : ''})`);
  return { status: 'SENT', channel: messageChannel, permalink };
}

// =========================== WORKFLOW B — APPROVED ===========================
function parseSlackLink(link: string): { channel: string; ts: string } | null {
  const clean = (link || '').split('?')[0];
  const m = clean.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/i);
  if (!m) return null;
  const digits = m[2];
  return { channel: m[1], ts: digits.slice(0, -6) + '.' + digits.slice(-6) };
}

function formatApproved(val: any): string {
  if (!val) return '—';
  if (/^\d+$/.test(String(val))) {
    const d = new Date(Number(val));
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
  return String(val);
}

export async function postScopeApproved(inspectionId: string): Promise<{ status: string; channel?: string; error?: string }> {
  const p = await fetchInspectionProperties(inspectionId, [
    'slackmessagelink', 'approved_at', 'approved_by_name', 'property_address_snapshot', 'inspector_name', 'resiwalk_inspection_url',
  ]);

  const slackLink = (p.slackmessagelink || '').toString().trim();
  const approvedByName = (p.approved_by_name || 'Unknown').toString();
  const propertyAddress = (p.property_address_snapshot || '').toString();
  const inspectorName = (p.inspector_name || '').toString();
  const resiwalkUrl = (p.resiwalk_inspection_url || '').toString().trim();

  const parsed = parseSlackLink(slackLink);
  if (!parsed) return { status: 'NO_VALID_LINK' };
  const { channel, ts } = parsed;

  // Admin gate (on/off). The reply MUST go to the original message's channel, so
  // sandbox reroute doesn't apply here — but if the pending went to sandbox, the
  // link already points there, so the thread is correct either way.
  const target = await resolveSlackTarget('scope_approved', channel);
  if (!target.enabled) return { status: 'DISABLED' };

  // approved_at may not be written yet → fall back to now (matches workflow).
  const approvedDisplay = formatApproved(p.approved_at || Date.now());

  // 1) Threaded blue reply.
  const reply = await slackCall('chat.postMessage', {
    channel,
    thread_ts: ts,
    reply_broadcast: false,
    text: `Inspection approved by ${approvedByName}`,
    attachments: [{
      color: COLOR_APPROVED,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: *This Inspection has been approved.*\n*Approved By:* ${approvedByName}\n*Approved At:* ${approvedDisplay}` } }],
    }],
  });
  if (!reply.ok) {
    console.error('[scope-slack] approved reply failed:', reply.error);
    return { status: 'REPLY_FAILED', channel, error: String(reply.error) };
  }

  // 2) Recolor the original card blue + APPROVED.
  const recordUrl = `https://app.hubspot.com/contacts/${PORTAL_ID}/record/${INSPECTION_OBJECT_TYPE}/${inspectionId}`;
  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: *APPROVED:* ${propertyAddress}  |  *Submitted By:* ${inspectorName}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Approved By:* ${approvedByName}    *Approved At:* ${approvedDisplay}` } },
  ];
  const buttons: any[] = [{ type: 'button', text: { type: 'plain_text', text: 'View Inspection in HubSpot', emoji: true }, url: recordUrl }];
  if (resiwalkUrl) buttons.push({ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Review Inspection', emoji: true }, url: resiwalkUrl });
  blocks.push({ type: 'actions', elements: buttons });

  const upd = await slackCall('chat.update', {
    channel, ts,
    text: `Approved: ${propertyAddress}`,
    attachments: [{ color: COLOR_APPROVED, blocks }],
  });
  if (!upd.ok) console.error('[scope-slack] chat.update (recolor) failed:', upd.error);

  console.log(`[scope-slack] approved replied for ${inspectionId} → ${channel}`);
  return { status: 'REPLIED', channel };
}
