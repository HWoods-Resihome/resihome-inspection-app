/**
 * POST /api/slack/interactivity — Slack interactive components for the PPW
 * "fail → dispatch" alerts (Grass now; Pool next). Set this as the Slack app's
 * *Interactivity* Request URL.
 *
 * Handles:
 *   - block_actions "leave_note"  → open a modal (views.open) for the Recurring
 *     Team to enter their note + an optional work-order due date.
 *   - view_submission             → write the note to the property + active
 *     listing, recolor the original card BLUE with a confirmation, and echo the
 *     note into the thread. Ack in <3s; the writes run in waitUntil().
 *
 * Same Slack signature verification as /api/slack/events (shared signing secret).
 * Public in middleware; self-authenticated by the signature.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '@/lib/slackBot';
import { slackCall, postSlackMessage } from '@/lib/slack';
import { createFailReviewNote, resolveInspectionPropertyId } from '@/lib/hubspot';
import { buildFailAttachment, buildNoteBody, type FailNoteCtx } from '@/lib/slackFailAlerts';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  if (!process.env.SLACK_SIGNING_SECRET) return res.status(503).json({ error: 'Slack not configured' });

  const rawBody = await readRawBody(req);
  const sig = req.headers['x-slack-signature'] as string | undefined;
  const ts = req.headers['x-slack-request-timestamp'] as string | undefined;
  if (!verifySlackSignature(rawBody, sig, ts)) return res.status(401).json({ error: 'bad signature' });

  let payload: any = {};
  try { payload = JSON.parse(new URLSearchParams(rawBody).get('payload') || '{}'); } catch { return res.status(400).json({ error: 'bad payload' }); }

  // ---- Button click → open the note modal --------------------------------
  if (payload.type === 'block_actions') {
    const action = (payload.actions || []).find((a: any) => a?.action_id === 'leave_note');
    if (!action) return res.status(200).end(); // e.g. the URL "Open inspection" button — nothing to do
    let ctx: FailNoteCtx;
    try { ctx = JSON.parse(action.value || '{}'); } catch { return res.status(200).end(); }

    const meta = {
      channel: payload.channel?.id || '',
      messageTs: payload.message?.ts || '',
      ...ctx,
    };
    const view = {
      type: 'modal',
      callback_id: 'leave_note_submit',
      private_metadata: JSON.stringify(meta).slice(0, 2900),
      title: { type: 'plain_text', text: `${ctx.reviewType} — Leave Note`.slice(0, 24) },
      submit: { type: 'plain_text', text: 'Add note' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${ctx.address || 'Property'}*${ctx.inspector ? `\nInspector: ${ctx.inspector}` : ''}` } },
        { type: 'input', block_id: 'note_block', label: { type: 'plain_text', text: 'Update / note (applied to property + listing)' },
          element: { type: 'plain_text_input', action_id: 'note', multiline: true } },
        { type: 'input', optional: true, block_id: 'due_block', label: { type: 'plain_text', text: 'Work order due date (optional)' },
          element: { type: 'datepicker', action_id: 'due' } },
      ],
    };
    // Must open within ~3s of the click (trigger_id is short-lived).
    const r = await slackCall('views.open', { trigger_id: payload.trigger_id, view });
    if (!r?.ok) console.warn('[slack-interactivity] views.open failed:', r?.error);
    return res.status(200).end();
  }

  // ---- Modal submit → write note, recolor card, thread the note ----------
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'leave_note_submit') {
    let meta: any = {};
    try { meta = JSON.parse(payload.view.private_metadata || '{}'); } catch { /* ignore */ }
    const vals = payload.view.state?.values || {};
    const note = String(vals.note_block?.note?.value || '').trim();
    const due = String(vals.due_block?.due?.selected_date || '').trim();

    if (!note) {
      // Inline modal error (keeps the modal open) — no work done.
      return res.status(200).json({ response_action: 'errors', errors: { note_block: 'Please enter a note.' } });
    }
    // Close the modal immediately; do the slow work after the ack.
    res.status(200).json({ response_action: 'clear' });

    const userId = payload.user?.id || '';
    waitUntil((async () => {
      try {
        const ctx = meta as FailNoteCtx;
        const propertyId = (meta.propertyId || '').trim() || (await resolveInspectionPropertyId(meta.inspectionId)) || '';
        let listingCount = 0;
        if (propertyId) {
          const r = await createFailReviewNote({ propertyId, body: buildNoteBody(ctx, note, due) });
          listingCount = r.listingCount;
        } else {
          console.warn('[slack-interactivity] no propertyId; note not written for', meta.inspectionId);
        }

        // Echo the note into the thread (mirrors the prior HubSpot confirmation).
        const listingStr = listingCount ? ` + ${listingCount}/${listingCount} listing` : '';
        const confirm = [
          `:white_check_mark: *Note added to HubSpot${listingStr}.*`,
          `*${ctx.address || ''}*`,
          ctx.inspector ? `Inspector: ${ctx.inspector}` : '',
          '',
          `*Update:* ${note}${due ? ` Work order will be due on ${due}.` : ''}`,
        ].filter(Boolean).join('\n');
        if (meta.channel && meta.messageTs) {
          await postSlackMessage(meta.channel, { text: 'Note added to HubSpot', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: confirm } }], thread_ts: meta.messageTs });
          // Recolor the original card BLUE + swap the action for a confirmation.
          const attachments = buildFailAttachment(ctx, { by: userId ? `<@${userId}>` : undefined, listingCount, noteBody: note });
          const upd = await slackCall('chat.update', { channel: meta.channel, ts: meta.messageTs, text: `${ctx.reviewType} note added — ${ctx.address}`, attachments });
          if (!upd?.ok) console.warn('[slack-interactivity] chat.update recolor failed:', upd?.error);
        }
      } catch (e) {
        console.error('[slack-interactivity] leave_note submit worker failed:', e);
      }
    })());
    return;
  }

  return res.status(200).end();
}
