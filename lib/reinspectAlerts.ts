/**
 * lib/reinspectAlerts.ts — Turn Re-Inspect + New Construction RRQC result Slack
 * alerts, ported from the two retired HubSpot workflow custom-code actions.
 *
 * postReinspectResultAlert({ inspectionId, templateType, baseUrl }) fires on EVERY
 * completion (and every re-completion after an edit), regardless of result:
 *   • PASS → aqua card ("move-in ready") to the region's PASS channel + a note on
 *     every active leasing deal on the property.
 *   • FAIL → pink card (Move-In-Ready-Date proximity + active-lease flags + an
 *     interactive "Update MIRD" button) to the region's FAIL channel + a deal note.
 *
 * Region → channel routing, MIRD lookup, active-lease-deal lookup, and deal-note
 * logging mirror the workflows. The admin Slack-Notifications gate (on/off +
 * sandbox) applies via resolveSlackTarget(), so it ships DARK until enabled.
 */
import {
  fetchInspectionProperties, fetchPropertyReinspectContext, fetchActiveLeaseDeals, logDealNote,
} from '@/lib/hubspot';
import { postSlackMessage } from '@/lib/slack';
import { resolveSlackTarget } from '@/lib/slackNotifications';
import {
  REINSPECT_LEASING_PIPELINE_ID, REINSPECT_WATCHED_STAGES, REINSPECT_STAGE_IDS, MIRD_FLAG_DAYS,
  COLOR_PASS, COLOR_FAIL, PASS_CHANNELS, FAIL_CHANNELS, NOTIFY_USER, podForRegion, REINSPECT_TEMPLATES,
} from '@/lib/reinspectAlertsConfig';

const PORTAL_ID = (process.env.HUBSPOT_PORTAL_ID || '22536354').trim();
const INSPECTION_OBJECT_TYPE = (process.env.HUBSPOT_INSPECTION_TYPE_ID || '2-63428834').trim();

const parseHsDate = (raw: any): Date | null => {
  if (raw === '' || raw == null) return null;
  const d = /^\d+$/.test(String(raw)) ? new Date(Number(raw)) : new Date(String(raw));
  return isNaN(d.getTime()) ? null : d;
};
const fmtDate = (raw: any): string => {
  const d = parseHsDate(raw);
  if (!d) return raw ? String(raw) : '—';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
};
const daysUntil = (raw: any): number | null => {
  const d = parseHsDate(raw);
  if (!d) return null;
  const now = new Date();
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((b - a) / 86400000);
};

export interface ReinspectAlertResult { status: string; result?: 'pass' | 'fail'; channel?: string; error?: string }

export async function postReinspectResultAlert(o: {
  inspectionId: string;
  templateType: string;
  baseUrl?: string;
}): Promise<ReinspectAlertResult> {
  const tpl = REINSPECT_TEMPLATES[o.templateType];
  if (!tpl) return { status: 'NOT_APPLICABLE' };

  const p = await fetchInspectionProperties(o.inspectionId, [
    'inspector_name', 'property_address_snapshot', 'property_id_ref',
    'resiwalk_inspection_url', 'inspection_result', 'qc_verdict',
  ]).catch(() => ({} as Record<string, any>));

  // Result — pass/fail. inspection_result is the standard verdict on both; a
  // Re-Inspect also carries qc_verdict. A blank/unknown verdict → skip (nothing
  // to announce yet).
  const raw = String(p.inspection_result || p.qc_verdict || '').trim().toLowerCase();
  const result: 'pass' | 'fail' | null = raw === 'pass' ? 'pass' : raw === 'fail' ? 'fail' : null;
  if (!result) return { status: 'NO_RESULT' };

  const propertyRecordId = String(p.property_id_ref || '').trim();
  const inspectorName = String(p.inspector_name || 'Unknown');
  const propertyAddress = String(p.property_address_snapshot || 'Address not provided');
  const resiwalkUrl = String(p.resiwalk_inspection_url || '').trim()
    || (o.baseUrl ? `${o.baseUrl.replace(/\/$/, '')}/inspection/${o.inspectionId}` : '');
  const recordUrl = `https://app.hubspot.com/contacts/${PORTAL_ID}/record/${INSPECTION_OBJECT_TYPE}/${o.inspectionId}`;

  // Region → POD → channel (PASS vs FAIL sets).
  const { region, mird } = await fetchPropertyReinspectContext(propertyRecordId);
  const pod = podForRegion(region);
  if (!pod) {
    console.warn(`[reinspect] no POD channel for region "${region || '(blank)'}" — skipping ${result} alert for ${o.inspectionId}.`);
    return { status: 'NO_CHANNEL', result, error: `Unroutable region: ${region || '(blank)'}` };
  }
  const intendedChannel = (result === 'pass' ? PASS_CHANNELS : FAIL_CHANNELS)[pod];

  // Admin gate (on/off + sandbox reroute). Ships DARK until enabled.
  const target = await resolveSlackTarget(tpl.slackKey, intendedChannel);
  if (!target.enabled) return { status: 'DISABLED', result };
  const channel = target.channel;

  // Active leasing deals (soonest lease start first).
  const deals = await fetchActiveLeaseDeals(propertyRecordId, {
    pipelineId: REINSPECT_LEASING_PIPELINE_ID, stageIds: REINSPECT_STAGE_IDS,
  }).catch(() => []);
  const primary = deals[0] || null;
  const extra = deals.length > 1 ? deals.length - 1 : 0;
  const stageName = primary ? (REINSPECT_WATCHED_STAGES[primary.stageId] || 'Lease in motion') : '';
  const mirdText = fmtDate(mird);

  const viewUrl = resiwalkUrl || recordUrl;
  let infoText =
    `*${propertyAddress}*\n` +
    `*Submitted By:*  ${inspectorName}\n` +
    `*Current Move-In Ready Date:*  ${mirdText}`;

  let payloadText: string;
  let color: string;
  const blocks: any[] = [];

  if (result === 'pass') {
    if (primary) {
      infoText += `\n*Pending Lease — ${stageName}*`;
      infoText += parseHsDate(primary.leaseStartRaw)
        ? `\n*Lease Start Date:*  ${fmtDate(primary.leaseStartRaw)}`
        : `\n*Lease Start Date:*  Pending`;
      if (extra > 0) infoText += `   _(+${extra} more active deal${extra > 1 ? 's' : ''})_`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: infoText } });
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: *Turn complete — this home passed re-inspect and is move-in ready.*` } });
    blocks.push({ type: 'actions', elements: [
      { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'View Inspection', emoji: true }, url: viewUrl },
    ] });
    payloadText = `*${tpl.title} Pass*  <@${NOTIFY_USER}>`;
    color = COLOR_PASS;
  } else {
    if (primary) {
      infoText += parseHsDate(primary.leaseStartRaw)
        ? `\n*Pending Lease — Lease Start Date:*  ${fmtDate(primary.leaseStartRaw)}`
        : `\n*Pending Lease* — Lease Start Date Pending`;
      if (extra > 0) infoText += `   _(+${extra} more active deal${extra > 1 ? 's' : ''})_`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: infoText } });

    const alerts: string[] = [];
    const mirdDays = daysUntil(mird);
    if (mirdDays !== null && mirdDays <= MIRD_FLAG_DAYS) {
      let whenTxt: string;
      if (mirdDays < 0) whenTxt = `was *${Math.abs(mirdDays)} day${Math.abs(mirdDays) === 1 ? '' : 's'} ago* and has already passed`;
      else if (mirdDays === 0) whenTxt = `is *today*`;
      else if (mirdDays === 1) whenTxt = `is *tomorrow*`;
      else whenTxt = `is *in ${mirdDays} days*`;
      alerts.push(`:warning: *Move-In Ready Date ${whenTxt}* (${mirdText}). This home just failed re-inspect — do we need to push the MIRD so it isn't leased before it's ready?`);
    }
    if (primary) {
      const dealLines = deals.map((d) => {
        const ls = parseHsDate(d.leaseStartRaw) ? `Lease Start Date: *${fmtDate(d.leaseStartRaw)}*` : `Lease Start Date Pending`;
        return `   • Deal Status: *${REINSPECT_WATCHED_STAGES[d.stageId] || 'In motion'}* — ${ls}`;
      }).join('\n');
      alerts.push(`:rotating_light: *This property has a Submitted Application | Pending Lease. Please Prioritize.*\n${dealLines}`);
    }
    if (alerts.length) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: alerts.join('\n\n') } });
    }

    const mirdButtonValue = JSON.stringify({
      address: propertyAddress, currentMird: mirdText,
      propertyId: propertyRecordId, inspectionId: o.inspectionId,
    });
    const buttons: any[] = [
      { type: 'button', action_id: 'open_mird_modal', text: { type: 'plain_text', text: 'Update MIRD', emoji: true }, value: mirdButtonValue },
    ];
    if (viewUrl) buttons.push({ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Review Inspection', emoji: true }, url: viewUrl });
    blocks.push({ type: 'actions', elements: buttons });

    payloadText = `*${tpl.title} Fail*`;
    color = COLOR_FAIL;
  }

  const post = await postSlackMessage(channel, {
    text: payloadText,
    attachments: [{ color, fallback: `${tpl.title} ${result === 'pass' ? 'Pass' : 'Fail'}: ${propertyAddress}`, blocks }],
  });
  if (!post.ok) {
    console.error(`[reinspect] ${result} post failed:`, post.error);
    return { status: 'POST_FAILED', result, channel, error: String(post.error) };
  }

  // Deal notes — on BOTH pass and fail, one per active leasing deal, every fire.
  const verb = result === 'pass' ? 'PASS' : 'FAIL';
  const line = result === 'pass'
    ? 'The Turn Inspect has been completed for this Turn. The home is move-in ready.'
    : 'This home was re-inspected and did NOT pass — it is not yet move-in ready.';
  const noteBody =
    `<strong>${tpl.title} — ${verb}</strong><br>${line}<br>` +
    `Property: ${propertyAddress}<br>Move-In Ready Date: ${mirdText}<br>Inspector: ${inspectorName}`;
  let notesAdded = 0;
  for (const d of deals) {
    const id = await logDealNote(d.id, noteBody);
    if (id) notesAdded++;
  }

  console.log(`[reinspect] ${result} posted for ${o.inspectionId} → ${channel} (region ${region || 'UNKNOWN'}${target.sandbox ? ', sandbox' : ''}); deals ${deals.length}, notes ${notesAdded}`);
  return { status: 'SENT', result, channel };
}
