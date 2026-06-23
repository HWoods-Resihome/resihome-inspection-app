/**
 * lib/listingPriceAlert.ts — when a 1099 Leasing Agent inspection is submitted
 * with an "Evaluate Listing Price" recommendation of REDUCE or INCREASE (and a
 * Recommended New Monthly Rent entered), post a Slack alert that:
 *   1) names the property + confirms whether it has an ACTIVE ResiHome listing,
 *   2) shows the current list price (listing_price) and the agent's recommended
 *      new rent + direction,
 *   3) includes 2–3 active RentCast comps to support/reject the recommendation.
 *
 * Sandbox channel for now (SLACK_LISTING_PRICE_CHANNEL overrides; defaults to the
 * test channel until go-live). Gated per inspection so a re-submit won't re-post.
 * Best-effort throughout — never blocks the submission.
 */
import {
  fetchActiveListingForProperty, resolveInspectionPropertyId,
  getListingPriceAlertStamp, stampListingPriceAlert, type SavedAnswer,
} from '@/lib/hubspot';
import { fetchRentComps, type RentComp } from '@/lib/rentcast';
import { postSlackMessage } from '@/lib/slack';

// LIVE: posts to the production channel by default. Override via
// SLACK_LISTING_PRICE_CHANNEL (e.g. set back to the sandbox C06CW2VMJNR to test).
const SANDBOX_CHANNEL = 'C06CW2VMJNR';
const LIVE_CHANNEL = 'C04K24M3UH5';
const SLACK_CHANNEL = (process.env.SLACK_LISTING_PRICE_CHANNEL || LIVE_CHANNEL).trim();
// The per-inspection gate (post once) engages only OFF the sandbox channel, so
// repeated test submits to the sandbox re-post freely while production never
// duplicates. In production (default) the gate is ON.
const GATE_ACTIVE = SLACK_CHANNEL !== SANDBOX_CHANNEL;
// Slack user IDs @-mentioned on each alert (override via SLACK_LISTING_PRICE_MENTIONS,
// comma-separated). Defaults to the listing-price reviewers.
const ALERT_MENTIONS = (process.env.SLACK_LISTING_PRICE_MENTIONS || 'UAZ5C6C5P,UFW4K81TQ')
  .split(',').map((s) => s.trim()).filter(Boolean);
const LISTING_RE = /evaluate listing price|listing price/i;

export interface ListingPriceInspectionRef {
  recordId: string;
  propertyAddressSnapshot: string;
  propertyRecordId: string | null;
  inspectorName?: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
}

const usd = (n: number | null | undefined) =>
  typeof n === 'number' && isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—';

function findListingPriceAnswer(answers: SavedAnswer[]): SavedAnswer | undefined {
  return answers.filter((a) => (a.answerType || 'qa') === 'qa').find((a) => LISTING_RE.test(a.answerSummary || ''));
}

/** Zillow address deep-link: /homes/<slug>_rb/ resolves to the property page
 *  (RentCast gives no zpid, so we can't build the canonical /homedetails/…_zpid/). */
function zillowUrl(addr: string): string {
  const slug = (addr || '').replace(/#/g, '').replace(/[.,]/g, '').trim().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
  return `https://www.zillow.com/homes/${slug}_rb/`;
}
/** Pre-filled Google "zillow {address} for rent" search — reliable fallback. */
function googleUrl(addr: string): string {
  return 'https://www.google.com/search?q=' + encodeURIComponent(`zillow ${addr} for rent`);
}

function compLine(c: RentComp, i: number): string {
  const bits = [
    usd(c.price) + '/mo',
    c.psf ? `$${c.psf}/sqft` : '',
    c.status,
    c.daysOnMarket ? `${c.daysOnMarket}d DOM` : '',
    c.distance ? `${c.distance.toFixed(2)}mi` : '',
  ].filter(Boolean).join(' · ');
  const addr = c.address || '(address n/a)';
  // Address links straight to Zillow; a small Google link as a fallback.
  return `*${i + 1}. <${zillowUrl(addr)}|${addr}>*\n${bits}  ·  <${googleUrl(addr)}|🔎 Google>`;
}

/** Advisory read on whether the recommended rent sits inside the comp/AVM range. */
function assessment(recommended: number, comps: RentComp[], avmRent: number, avmLow: number, avmHigh: number): string {
  if (avmRent > 0 && avmLow > 0 && avmHigh > 0) {
    if (recommended < avmLow) return `Recommended ${usd(recommended)} is *below* the AVM range (${usd(avmLow)}–${usd(avmHigh)}). Comps suggest room to hold higher.`;
    if (recommended > avmHigh) return `Recommended ${usd(recommended)} is *above* the AVM range (${usd(avmLow)}–${usd(avmHigh)}). Comps may not support it.`;
    return `Recommended ${usd(recommended)} is *within* the AVM range (${usd(avmLow)}–${usd(avmHigh)}) — supported by comps.`;
  }
  const prices = comps.map((c) => c.price).filter((p) => p > 0).sort((a, b) => a - b);
  if (prices.length) {
    const median = prices[Math.floor(prices.length / 2)];
    const rel = recommended < median ? 'below' : recommended > median ? 'above' : 'at';
    return `Recommended ${usd(recommended)} is ${rel} the comp median (${usd(median)}).`;
  }
  return 'No comps available to validate — review manually.';
}

export async function postListingPriceAlertOnSubmit(
  inspection: ListingPriceInspectionRef,
  answers: SavedAnswer[],
  opts?: { baseUrl?: string },
): Promise<{ posted: boolean; reason?: string; channel?: string; error?: string }> {
  // 1) Trigger: an "Evaluate Listing Price" answer of Reduce/Increase + an amount.
  const ans = findListingPriceAnswer(answers);
  if (!ans) return { posted: false, reason: 'no listing-price answer' };
  const dir = (ans.answerValue || '').trim().toLowerCase();
  if (dir !== 'reduce' && dir !== 'increase') return { posted: false, reason: `direction=${dir || 'none'}` };
  const recommended = Number(ans.recommendedAmount) || 0;
  if (recommended <= 0) return { posted: false, reason: 'no recommended amount' };

  // 2) Gate: one alert per inspection (production only; sandbox re-posts freely).
  if (GATE_ACTIVE) {
    const stamp = await getListingPriceAlertStamp(inspection.recordId);
    if (stamp) return { posted: false, reason: 'gated (already posted)' };
  }

  // 3) Resolve the property + its ACTIVE listing (field or association).
  const propertyId = await resolveInspectionPropertyId(inspection.recordId, inspection.propertyRecordId);
  const listing = propertyId ? await fetchActiveListingForProperty(propertyId).catch(() => null) : null;
  const listingStatus = listing?.listingStatus || '';
  const isActive = /active|publish/i.test(listingStatus);
  const currentPrice = listing?.listingPrice ?? null;

  // 4) Comps from RentCast.
  const comps = await fetchRentComps({
    address: inspection.propertyAddressSnapshot,
    bed: inspection.bedrooms, bath: inspection.bathrooms,
  }).catch((e) => ({ ok: false, avmRent: 0, avmLow: 0, avmHigh: 0, comps: [], totalReturned: 0, attempt: 0, error: String(e?.message || e) } as any));

  // 5) Build the message.
  const base = (opts?.baseUrl || 'https://resiwalk.com').replace(/\/+$/, '');
  const inspectionUrl = `${base}/inspection/${inspection.recordId}`;
  const arrow = dir === 'reduce' ? '🔻' : '🔺';
  const dirWord = dir === 'reduce' ? 'Reduce' : 'Increase';
  const delta = currentPrice != null ? recommended - currentPrice : null;
  const deltaStr = delta != null ? ` (${delta >= 0 ? '+' : '−'}${usd(Math.abs(delta))})` : '';
  const address = (inspection.propertyAddressSnapshot || '').trim() || '(address n/a)';

  const listingLine = !propertyId
    ? '⚠️ No associated property found'
    : !listing
      ? '⚠️ No ResiHome listing found for this property'
      : isActive
        ? `✅ Active listing · current list *${usd(currentPrice)}/mo*`
        : `⚠️ Listing is *${listingStatus || 'not active'}* · last list ${usd(currentPrice)}/mo`;

  const text = `Listing price ${dirWord} recommendation — ${address}: ${usd(recommended)}/mo`;
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: `${arrow} Listing Price ${dirWord} — Agent Recommendation`, emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Property:*\n${address}` },
      { type: 'mrkdwn', text: `*Listing:*\n${listingLine}` },
      { type: 'mrkdwn', text: `*Agent recommends:*\n${arrow} ${dirWord} to *${usd(recommended)}/mo*${deltaStr}` },
      { type: 'mrkdwn', text: `*Inspector:*\n${inspection.inspectorName || '—'}` },
    ] },
  ];

  // Inspector's note/feedback on the listing-price recommendation, when present.
  const note = (ans.note || '').trim();
  if (note) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Agent note:*\n>${note.replace(/\n/g, '\n>')}` } });

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${inspectionUrl}|Open inspection ↗>` } });
  // Notify the listing-price reviewers (Slack user IDs).
  if (ALERT_MENTIONS.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ALERT_MENTIONS.map((u) => `<@${u}>`).join(' ') } });
  }
  blocks.push({ type: 'divider' });
  // Comps live in the thread to keep the parent compact — pointer here.
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '💬 *Comparable homes in thread* — tap *replies* below' }] });

  // Build the threaded reply that carries the full comp data + assessment.
  const replyBlocks: any[] = [];
  let replyText = 'Comparable homes';
  if (comps.ok && comps.comps.length) {
    const avmLine = comps.avmRent > 0 ? `  ·  AVM ${usd(comps.avmRent)} (${usd(comps.avmLow)}–${usd(comps.avmHigh)})` : '';
    replyBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Active market comps (RentCast)*${avmLine}` } });
    replyBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: comps.comps.map(compLine).join('\n\n') } });
    replyBlocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `📊 ${assessment(recommended, comps.comps, comps.avmRent, comps.avmLow, comps.avmHigh)}` }] });
    replyText = `${comps.comps.length} comparable homes for ${address}`;
  } else {
    replyBlocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `📊 No comps available to validate (${comps.error || 'none found'}) — review manually.` }] });
    replyText = 'No comparable homes found';
  }

  // 6) Post the parent, then the comps as a threaded reply. Stamp on parent success.
  const res = await postSlackMessage(SLACK_CHANNEL, { text, blocks });
  if (res.ok) {
    if (GATE_ACTIVE) await stampListingPriceAlert(inspection.recordId);
    let threadOk = false;
    if (res.ts) {
      const reply = await postSlackMessage(SLACK_CHANNEL, { text: replyText, blocks: replyBlocks, thread_ts: res.ts });
      threadOk = reply.ok;
      if (!reply.ok) console.warn(`[listing-price-alert] ${inspection.recordId}: comps thread reply failed: ${reply.error}`);
    }
    console.log(`[listing-price-alert] ${inspection.recordId}: posted to ${res.channel} (${dirWord} ${usd(recommended)}, ${comps.comps?.length || 0} comps, thread ${threadOk ? 'ok' : 'missing'})`);
    return { posted: true, channel: res.channel };
  }
  console.warn(`[listing-price-alert] ${inspection.recordId}: Slack post failed: ${res.error}`);
  return { posted: false, reason: 'slack post failed', error: res.error, channel: SLACK_CHANNEL };
}
