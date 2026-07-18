/**
 * Internal Slack notifications for the Services flow — the coordinator-facing
 * alerts the app was missing (a submit lands in Review, a review is rejected, a
 * bid item is created). Each posts through the shared admin gate
 * (resolveSlackTarget) keyed by a stable notification id, so it appears in the
 * Admin ▸ Slack Notifications table with an On/Off + Sandbox toggle and a live
 * channel field.
 *
 * IMPORTANT: the intended channel is BLANK. With no live channel configured, the
 * post is a silent no-op — so these ship "dark" and go live the moment an admin
 * types a channel into the Slack Notifications table. Best-effort: Slack never
 * blocks or fails a service action.
 */
import { postSlackMessage } from '@/lib/slack';
import { resolveSlackTarget } from '@/lib/slackNotifications';
import { appBaseUrl } from '@/lib/notifications/send';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';

export interface ServiceSlackCtx {
  serviceId: string;
  address?: string | null;
  worktype?: string | null;
  subtype?: string | null;
  vendorName?: string | null;
}

function workLabel(ctx: ServiceSlackCtx): string {
  const wt = String(ctx.worktype || '');
  return `${worktypeLabel(wt)} (${subtypeLabel(wt, String(ctx.subtype || ''))})`;
}
function link(serviceId: string): string {
  return `${appBaseUrl()}/services/${encodeURIComponent(serviceId)}`;
}

async function post(key: string, text: string): Promise<void> {
  try {
    // Blank intended channel → resolves to '' unless an admin set a live channel,
    // in which case posting is skipped (dark until configured).
    const target = await resolveSlackTarget(key, '');
    if (!target.enabled) return;
    const channel = (target.channel || '').trim();
    if (!channel) return;
    await postSlackMessage(channel, { text });
  } catch { /* best-effort — Slack never blocks a service action */ }
}

/** A completed/uncompleted submission landed in human Review. */
export function notifyServiceSubmittedSlack(ctx: ServiceSlackCtx): Promise<void> {
  const who = ctx.vendorName ? ` · ${ctx.vendorName}` : '';
  return post('service_submitted',
    `:mag: *Service submitted for review* — ${workLabel(ctx)} at ${ctx.address || 'a property'}${who}\n<${link(ctx.serviceId)}|Open service>`);
}

/** A reviewer rejected a submitted service. */
export function notifyServiceRejectedSlack(ctx: ServiceSlackCtx & { reviewer?: string | null; notes?: string | null }): Promise<void> {
  const by = ctx.reviewer ? ` by ${ctx.reviewer}` : '';
  const note = ctx.notes ? `\n> ${String(ctx.notes).slice(0, 300)}` : '';
  return post('service_rejected',
    `:x: *Service review rejected*${by} — ${workLabel(ctx)} at ${ctx.address || 'a property'}${note}\n<${link(ctx.serviceId)}|Open service>`);
}

/** The crew flagged extra work → a new Bid Item was created for internal review. */
export function notifyServiceBidCreatedSlack(ctx: ServiceSlackCtx & { bidId: string; description?: string | null; vendorCost?: number | null }): Promise<void> {
  const cost = typeof ctx.vendorCost === 'number' && Number.isFinite(ctx.vendorCost) ? ` · $${ctx.vendorCost}` : '';
  const desc = ctx.description ? `\n> ${String(ctx.description).slice(0, 300)}` : '';
  return post('service_bid_created',
    `:memo: *New bid item* — ${ctx.address || 'a property'}${cost}${desc}\n<${link(ctx.bidId)}|Open bid item>`);
}
