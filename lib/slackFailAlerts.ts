/**
 * lib/slackFailAlerts.ts — shared card for the PPW "fail → dispatch" Slack alerts
 * (Grass now; Pool next) that fire from ResiWalk.
 *
 * The card carries a PINK accent bar and two buttons: "View Report" (opens the
 * inspection) and "Leave Note on Property" for the Recurring Team. The button
 * CLICK is handled by the SHARED Slack interactivity handler at the app's
 * configured Interactivity Request URL (currently
 * https://v0-resihome.vercel.app/api/interactivity) — the SAME handler the pool
 * fail already uses. It opens the note modal, writes the note to the property +
 * active listing, recolors the card, and threads the note.
 *
 * So this module only POSTS the alert; it must emit the button `value` in the
 * EXACT contract that shared handler expects (keyed by `reviewType`). Keep this
 * blob in lockstep with the pool custom-code action's `leave_note` value.
 */

export type FailReviewType = 'Grass' | 'Pool';

export const PINK = '#FF0066'; // ResiHome hot pink — NEW / needs action

// Single label the shared v0 interactivity handler keys on for BOTH grass and
// pool fails, so one branch there serves both alerts.
export const SHARED_REVIEW_TYPE = 'Grass/Pool';

// Side-by-side thumbnail strip for pool photos (same service the pool
// custom-code action used).
const MONTAGE_BASE = 'https://v0-resihome.vercel.app/api/montage';

/** Context for rendering the card + the shared handler's `leave_note` payload. */
export interface FailNoteCtx {
  reviewType: FailReviewType;
  inspectionId: string;      // HubSpot inspection record id (objectId)
  propertyId?: string;       // property_id_ref (resolved server-side when blank)
  address: string;
  inspector?: string;
  response?: string;         // the failing answer value (grass/pool condition)
  inspectorNote?: string;    // the inspector's fail reason (passed as `note`)
  openUrl?: string;          // deep link to the inspection (passed as `reportUrl`)
  photosCount?: number;      // count shown on the card (photos are threaded)
  photos?: string[];         // photo URLs — pool renders a montage strip in-card
  mentions?: string[];       // Slack user ids to @-mention (pool warning line)
}

function viewReportBtn(url: string) {
  return {
    type: 'button', action_id: 'open_inspection', style: 'primary',
    text: { type: 'plain_text', text: 'View Report', emoji: true }, url,
  };
}

/**
 * The "Leave Note on Property" button. `value` MUST match the shared v0
 * interactivity handler's expected schema (mirrors the pool custom-code action):
 *   { action, reviewType, inspectionId, propertyId, address, inspector, note, reportUrl }
 * Slack caps a button value at 2000 chars.
 */
function leaveNoteBtn(c: FailNoteCtx) {
  return {
    type: 'button', action_id: 'leave_note', style: 'danger',
    text: { type: 'plain_text', text: 'Leave Note on Property', emoji: true },
    value: JSON.stringify({
      action: 'leave_note',
      reviewType: SHARED_REVIEW_TYPE, // 'Grass/Pool' — one branch serves both
      inspectionId: c.inspectionId,
      propertyId: c.propertyId || '',
      address: c.address,
      inspector: c.inspector || '',
      note: (c.inspectorNote || '').slice(0, 600),
      reportUrl: c.openUrl || '',
    }).slice(0, 1900),
  };
}

/** Grass card (mirrors the existing PPW-dispatch layout; adds the buttons). */
function grassBlocks(c: FailNoteCtx): any[] {
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: '🌱 Grass Fail — PPW Dispatch', emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Property:*\n${c.address || '(address n/a)'}` },
      { type: 'mrkdwn', text: `*Grass condition:*\n🔻 ${c.response || 'Fail'}` },
      { type: 'mrkdwn', text: `*Inspector:*\n${c.inspector || '—'}` },
      { type: 'mrkdwn', text: `*Photos:*\n${c.photosCount ? `${c.photosCount} attached (see thread)` : 'none'}` },
    ] },
  ];
  if (c.inspectorNote) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Inspector note:*\n>${c.inspectorNote.replace(/\n/g, '\n>')}` } });
  const els: any[] = [];
  if (c.openUrl && /^https?:/i.test(c.openUrl)) els.push(viewReportBtn(c.openUrl));
  els.push(leaveNoteBtn(c));
  blocks.push({ type: 'actions', elements: els });
  return blocks;
}

/** Pool card (mirrors the prior HubSpot pool custom-code action: warning +
 *  detail + montage image strip + buttons). */
function poolBlocks(c: FailNoteCtx): any[] {
  const mentions = (c.mentions || []).map((u) => `<@${u}>`).join(' ');
  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text:
      `:warning: ${mentions ? mentions + ' ' : ''}an *inspection* has been submitted and the *Pool* review has *failed*. Please review PPW and submit feedback.` } },
    { type: 'section', text: { type: 'mrkdwn', text: [
      `*${c.address || 'Address unavailable'}*`,
      c.inspector ? `Inspector: ${c.inspector}` : null,
      c.inspectorNote ? `Note: ${c.inspectorNote}` : null,
    ].filter(Boolean).join('\n') } },
  ];
  const photos = (c.photos || []).filter(Boolean).slice(0, 4);
  if (photos.length) {
    blocks.push({ type: 'image', image_url: `${MONTAGE_BASE}?u=${encodeURIComponent(photos.join(','))}`, alt_text: 'Pool condition photos' });
  }
  const els: any[] = [];
  if (c.openUrl && /^https?:/i.test(c.openUrl)) els.push(viewReportBtn(c.openUrl));
  els.push(leaveNoteBtn(c));
  blocks.push({ type: 'actions', elements: els });
  return blocks;
}

/** Build the PINK attachment for a fail card (layout per reviewType). */
export function buildFailAttachment(c: FailNoteCtx): any[] {
  const blocks = c.reviewType === 'Pool' ? poolBlocks(c) : grassBlocks(c);
  return [{ color: PINK, fallback: `${c.reviewType} review FAILED — ${c.address}`, blocks }];
}
