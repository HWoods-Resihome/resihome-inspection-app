/**
 * POST /api/slack/interactivity — Slack interactivity (block_actions + view_submission).
 *
 * Handles the FAIL card's "Update MIRD" button:
 *   • block_actions → open a date-picker modal (views.open) prefilled with the
 *     current Move-In Ready Date; the property + inspection ids ride in
 *     private_metadata.
 *   • view_submission → write the chosen date back to the Property's
 *     move_in_ready_date, then clear the modal.
 *
 * Slack posts x-www-form-urlencoded with a `payload` field; the signature is over
 * the raw body, so bodyParser is disabled. Requires SLACK_SIGNING_SECRET and the
 * Slack app's Interactivity Request URL pointed here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '@/lib/slackBot';
import { slackCall } from '@/lib/slack';
import { updatePropertyMoveInReadyDate } from '@/lib/hubspot';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// "Aug 5, 2026" / epoch / ISO → YYYY-MM-DD (for the date-picker initial_date), or ''.
function toIsoDay(v: string): string {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  return isNaN(+d) ? '' : d.toISOString().slice(0, 10);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  const rawBody = await readRawBody(req);
  if (!process.env.SLACK_SIGNING_SECRET) return res.status(503).json({ error: 'Slack interactivity not configured' });
  const sig = req.headers['x-slack-signature'] as string | undefined;
  const ts = req.headers['x-slack-request-timestamp'] as string | undefined;
  if (!verifySlackSignature(rawBody, sig, ts)) return res.status(401).json({ error: 'bad signature' });

  let payload: any = {};
  try {
    const params = new URLSearchParams(rawBody);
    payload = JSON.parse(params.get('payload') || '{}');
  } catch { return res.status(400).json({ error: 'bad payload' }); }

  // 1) Button click → open the MIRD date-picker modal.
  if (payload.type === 'block_actions') {
    const action = (payload.actions || []).find((a: any) => a.action_id === 'open_mird_modal');
    if (!action) return res.status(200).end();
    let ctx: any = {};
    try { ctx = JSON.parse(action.value || '{}'); } catch { /* ignore */ }
    const initial = toIsoDay(String(ctx.currentMird || ''));
    const view: any = {
      type: 'modal',
      callback_id: 'mird_modal',
      private_metadata: JSON.stringify({ propertyId: String(ctx.propertyId || ''), inspectionId: String(ctx.inspectionId || '') }),
      title: { type: 'plain_text', text: 'Update MIRD' },
      submit: { type: 'plain_text', text: 'Save' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${ctx.address || 'Property'}*\nSet a new Move-In Ready Date.` } },
        {
          type: 'input', block_id: 'mird_block',
          label: { type: 'plain_text', text: 'Move-In Ready Date' },
          element: { type: 'datepicker', action_id: 'mird_date', ...(initial ? { initial_date: initial } : {}) },
        },
      ],
    };
    // ACK immediately; open the modal in the background (trigger_id is valid ~3s,
    // so do it right away — waitUntil keeps the HTTP ack fast either way).
    waitUntil(slackCall('views.open', { trigger_id: payload.trigger_id, view }).then((r) => {
      if (!r?.ok) console.error('[slack-interactivity] views.open failed:', r?.error);
    }));
    return res.status(200).end();
  }

  // 2) Modal submit → write the new MIRD to the Property.
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'mird_modal') {
    let md: any = {};
    try { md = JSON.parse(payload.view.private_metadata || '{}'); } catch { /* ignore */ }
    const selected = payload.view?.state?.values?.mird_block?.mird_date?.selected_date || '';
    const propertyId = String(md.propertyId || '');
    if (propertyId && selected) {
      waitUntil(updatePropertyMoveInReadyDate(propertyId, selected).catch((e) => console.error('[slack-interactivity] MIRD write failed:', e?.message || e)));
    }
    return res.status(200).json({}); // clears the modal
  }

  return res.status(200).end();
}
