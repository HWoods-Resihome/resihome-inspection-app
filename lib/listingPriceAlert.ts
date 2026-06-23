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

// Sandbox/test channel until the flow is verified; flip via env to go live
// (live channel: C04K24M3UH5).
const SANDBOX_CHANNEL = 'C06CW2VMJNR';
const SLACK_CHANNEL = (process.env.SLACK_LISTING_PRICE_CHANNEL || SANDBOX_CHANNEL).trim();
// The per-inspection gate (post once) engages only OFF the sandbox channel, so
// repeated test submits to the sandbox re-post freely while production never
// duplicates.
const GATE_ACTIVE = SLACK_CHANNEL !== SANDBOX_CHANNEL;
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

function compLine(c: RentComp, i: number): string {
  const bits = [
    usd(c.price) + '/mo',
    c.psf ? `$${c.psf}/sqft` : '',
    c.status,
    c.daysOnMarket ? `${c.daysOnMarket}d DOM` : '',
    c.distance ? `${c.distance.toFixed(2)}mi` : '',
  ].filter(Boolean).join(' · ');
  return `*${i + 1}. ${c.address || '(address n/a)'}*\n${bits}`;
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
  blocks.push({ type: 'divider' });

  if (comps.ok && comps.comps.length) {
    const avmLine = comps.avmRent > 0 ? `  ·  AVM ${usd(comps.avmRent)} (${usd(comps.avmLow)}–${usd(comps.avmHigh)})` : '';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Active market comps (RentCast)*${avmLine}` } });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: comps.comps.map(compLine).join('\n\n') } });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `📊 ${assessment(recommended, comps.comps, comps.avmRent, comps.avmLow, comps.avmHigh)}` }] });
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `📊 No comps available to validate (${comps.error || 'none found'}) — review manually.` }] });
  }

  // 6) Post + stamp on success.
  const res = await postSlackMessage(SLACK_CHANNEL, { text, blocks });
  if (res.ok) {
    if (GATE_ACTIVE) await stampListingPriceAlert(inspection.recordId);
    console.log(`[listing-price-alert] ${inspection.recordId}: posted to ${res.channel} (${dirWord} ${usd(recommended)}, ${comps.comps?.length || 0} comps)`);
    return { posted: true, channel: res.channel };
  }
  console.warn(`[listing-price-alert] ${inspection.recordId}: Slack post failed: ${res.error}`);
  return { posted: false, reason: 'slack post failed', error: res.error, channel: SLACK_CHANNEL };
}
