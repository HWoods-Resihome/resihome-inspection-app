/**
 * lib/slackFailAlerts.ts — shared card + note logic for the PPW "fail → dispatch"
 * Slack alerts (Grass now; Pool next) that fire from ResiWalk.
 *
 * The card carries a PINK accent bar when NEW, with a "Leave Note on Property"
 * button for the Recurring Team. When they submit the note (via the modal handled
 * in /api/slack/interactivity), the note is written to the property + active
 * listing, the card recolors BLUE with a "note added" confirmation, and the note
 * is echoed into the thread — mirroring the prior HubSpot pool-fail flow, now
 * app-owned.
 *
 * The builder is keyed by `reviewType` so the same interactivity handler serves
 * both alerts (the button's value blob carries the type + context needed to
 * rebuild the card on recolor).
 */

export type FailReviewType = 'Grass' | 'Pool';

export const PINK = '#FF0066'; // ResiHome hot pink — NEW / needs action
export const BLUE = '#2F6FED'; // resolved — note left

/** Everything needed to render a card AND to rebuild it on recolor (so this is
 *  also exactly what the button value blob / modal private_metadata carry). */
export interface FailNoteCtx {
  reviewType: FailReviewType;
  inspectionId: string;      // HubSpot inspection record id
  propertyId?: string;       // resolved when available; handler resolves if blank
  address: string;
  inspector?: string;
  response?: string;         // the failing answer value (e.g. "Fail - Needs Attention")
  inspectorNote?: string;    // the inspector's fail reason
  openUrl?: string;          // deep link to the inspection
  photosCount?: number;      // count shown on the card (photos are threaded)
}

export interface ResolvedInfo { by?: string; listingCount?: number; noteBody?: string; }

function openBtn(url: string) {
  return { type: 'button', action_id: 'open_inspection', text: { type: 'plain_text', text: 'Open inspection', emoji: true }, url };
}
function leaveNoteBtn(c: FailNoteCtx) {
  return {
    type: 'button', action_id: 'leave_note', style: 'danger',
    text: { type: 'plain_text', text: 'Leave Note on Property', emoji: true },
    // Slack caps a button value at 2000 chars.
    value: JSON.stringify({
      reviewType: c.reviewType, inspectionId: c.inspectionId, propertyId: c.propertyId || '',
      address: c.address, inspector: c.inspector || '', response: c.response || '',
      inspectorNote: (c.inspectorNote || '').slice(0, 600), openUrl: c.openUrl || '', photosCount: c.photosCount || 0,
    }).slice(0, 1900),
  };
}

/** Grass card (mirrors the existing PPW-dispatch layout; adds the action button). */
function grassBlocks(c: FailNoteCtx, resolved?: ResolvedInfo): any[] {
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

  if (resolved) {
    const listing = resolved.listingCount ? ` + ${resolved.listingCount}/${resolved.listingCount} listing` : '';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: *Note added to HubSpot${listing}.*${resolved.noteBody ? `\n\n*Update:* ${resolved.noteBody}` : ''}` } });
    if (resolved.by) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Note left by ${resolved.by}` }] });
    if (c.openUrl) blocks.push({ type: 'actions', elements: [openBtn(c.openUrl)] });
  } else {
    const els: any[] = [];
    if (c.openUrl) els.push(openBtn(c.openUrl));
    els.push(leaveNoteBtn(c));
    blocks.push({ type: 'actions', elements: els });
  }
  return blocks;
}

/** Build the colored attachment for a fail card. NEW = pink; resolved = blue. */
export function buildFailAttachment(c: FailNoteCtx, resolved?: ResolvedInfo): any[] {
  // Pool layout is added when the pool alert is ported; today only Grass posts.
  const blocks = grassBlocks(c, resolved);
  return [{ color: resolved ? BLUE : PINK, fallback: `${c.reviewType} review FAILED — ${c.address}`, blocks }];
}

/** The note body written to the property + active listing when the team submits. */
export function buildNoteBody(c: FailNoteCtx, note: string, due?: string): string {
  return [
    `ResiWalk ${c.reviewType} review — Recurring Team follow-up`,
    c.address ? `Property: ${c.address}` : '',
    c.inspector ? `Inspector: ${c.inspector}` : '',
    '',
    note.trim(),
    due ? `\nWork order will be due on ${due}.` : '',
  ].filter((l, i) => l !== '' || i === 3).join('\n').trim();
}
