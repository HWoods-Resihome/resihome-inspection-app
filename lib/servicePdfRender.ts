/**
 * Render a Service Work Order completion PDF to a Buffer, server-side. Shared by
 * the inline PDF endpoint (pages/api/services/[id]/pdf.ts) and the "service
 * completed" email notification (which attaches the vendor copy). Photos are
 * fetched + downscaled to data URIs so react-pdf renders them reliably.
 */
import sharp from 'sharp';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { fetchServiceWorkOrder, readServiceForms, findServiceBidChildren } from '@/lib/hubspot';
import { worktypeLabel, subtypeLabel, type Worktype } from '@/lib/services/worktypes';
import { DEFAULT_SERVICE_FORMS, formKey } from '@/lib/services/serviceForms';
import { PROOF_URL_KEY } from '@/lib/services/model';
import { ServicePdf, type ServicePdfData } from '@/lib/servicePdf';
import { safeProxyFetch, readBodyCapped, isAllowedPhotoHost } from '@/lib/safeProxyFetch';
import { reviewerDisplayName } from '@/lib/reviewerName';

const money = (v: any) => { const n = Number(v); return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''; };
const splitUrls = (v: any): string[] => String(v || '').split(/[\n,]+/).map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x.split('#')[0]));
const normDate = (v: any): string => { const t = String(v ?? '').trim(); if (!t) return ''; if (/^\d{10,}$/.test(t)) return new Date(Number(t)).toISOString().slice(0, 10); return t.slice(0, 10); };

async function toDataUri(url: string): Promise<string | null> {
  try {
    const clean = url.split('#')[0];
    // SSRF guard: only allowed photo hosts, fetched via safeProxyFetch (validates
    // every redirect hop resolves to a public IP) so a stored URL can't pull an
    // internal/metadata address into the admin-viewed PDF.
    if (!isAllowedPhotoHost(clean)) return null;
    const r = await safeProxyFetch(clean);
    if (!r.ok) return null;
    const buf = await readBodyCapped(r, 40 * 1024 * 1024);
    // failOn:'truncated' → a partial/corrupt upload throws (→ dropped) instead of
    // decoding as a BLACK frame; also reject a solid near-black frame outright.
    const base = sharp(buf, { failOn: 'truncated' }).rotate();
    try {
      const stats = await base.clone().stats();
      if (stats.channels.slice(0, 3).every((c) => c.max <= 8)) return null;
    } catch { /* stats failed → the resize below surfaces a real decode error */ }
    const jpeg = await base.resize(360, 360, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 62 }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch { return null; }
}
async function encodeAll(urls: string[], cap = 8): Promise<string[]> {
  const out = await Promise.all(urls.slice(0, cap).map(toDataUri));
  return out.filter((x): x is string => !!x);
}

/**
 * Build the PDF buffer for a live service. `variant` 'vendor' (default) shows the
 * vendor cost; 'client' shows client cost + is internal-only (caller enforces).
 * `baseUrl` is the app origin used for the photo-gallery link. Returns null when
 * the record can't be loaded.
 */
export async function renderServicePdfBuffer(id: string, opts: { variant: 'vendor' | 'client'; baseUrl: string; internal: boolean }): Promise<Buffer | null> {
  const rec = await fetchServiceWorkOrder(id);
  if (!rec) return null;
  const p = rec.props;
  const worktype = (p.worktype || '') as Worktype;
  const subtype = p.subtype || '';
  const answersRaw = (() => { try { return JSON.parse(p.answers_json || '{}'); } catch { return {}; } })();
  const savedForms = await readServiceForms().catch(() => null);
  const form = ({ ...DEFAULT_SERVICE_FORMS, ...(savedForms || {}) })[formKey(worktype, subtype)] || [];
  const answers = form
    .filter((q) => answersRaw[q.id] != null && answersRaw[q.id] !== '')
    .map((q) => {
      const base = Array.isArray(answersRaw[q.id]) ? answersRaw[q.id].join(', ') : String(answersRaw[q.id]);
      const note = q.type === 'yesno' && answersRaw[q.id] === 'no' ? String(answersRaw[`${q.id}__note`] || '').trim() : '';
      return { label: q.label, value: note ? `${base} — ${note}` : base };
    });

  const [before, after, petBefore, petAfter, proofPhotos] = await Promise.all([
    encodeAll(splitUrls(p.before_photo_urls)), encodeAll(splitUrls(p.after_photo_urls)),
    encodeAll(splitUrls(p.pet_before_photo_urls)), encodeAll(splitUrls(p.pet_after_photo_urls)),
    // Photos extracted from the vendor's proof-of-service PDF (AI-review step).
    encodeAll(splitUrls(p.proof_photo_urls), 12),
  ]);
  // Link to the vendor's original proof document (from their completion answers).
  const proofLinkRaw = String(answersRaw[PROOF_URL_KEY] || '').trim();
  const proofLink = /^https?:\/\//i.test(proofLinkRaw) ? proofLinkRaw : '';

  const bidChildren = await findServiceBidChildren(id).catch(() => []);
  const bids = await Promise.all(bidChildren.map(async (c) => ({
    description: c.props.service_description || '',
    cost: money(c.props.vendor_cost),
    status: c.props.status || '',
    photos: await encodeAll(splitUrls(c.props.before_photo_urls)),
  })));

  const d: ServicePdfData = {
    address: p.address_snapshot || p.service_name || '(Service)', locality: p.locality_snapshot || '',
    worktype: worktypeLabel(worktype), subtype: subtypeLabel(worktype, subtype),
    scope: p.scope === 'community' ? 'Community' : 'SFR', vendor: p.vendor_name || '',
    status: p.status || '', dueDate: normDate(p.due_date), submittedAt: normDate(p.submitted_at), completedAt: normDate(p.completed_at),
    vendorCost: money(p.vendor_cost), markupPct: p.markup_pct != null ? String(p.markup_pct) : '', clientCost: money(p.client_cost),
    // Community grass-cut master with a common area → the two-line vendor breakdown.
    ...(() => {
      const commonArea = Number(p.common_area_cost);
      const homes = Number(p.covered_property_count);
      const rate = Number(p.per_property_rate);
      const isMaster = p.scope === 'community' && worktype === 'landscaping' && subtype === 'cut'
        && !String(p.master_service_id || '').trim() && !!String(p.covered_property_ids || '').trim();
      if (!isMaster || !(Number.isFinite(commonArea) && commonArea > 0)) return {};
      const houseSub = Number.isFinite(homes) && Number.isFinite(rate) ? Math.round(homes * rate * 100) / 100 : NaN;
      return {
        houseCuts: Number.isFinite(houseSub) ? money(houseSub) : '',
        commonArea: money(commonArea),
        houseCutsLabel: Number.isFinite(homes) && Number.isFinite(rate) ? `House Cuts (${homes} × ${money(rate)})` : 'House Cuts',
      };
    })(),
    adjustment: p.vendor_cost_adjustment && Number(p.vendor_cost_adjustment) > 0 ? money(p.vendor_cost_adjustment) : '', adjustmentReason: p.vendor_cost_adjustment_reason || '',
    aiVerdict: p.ai_verdict || '', aiNotes: p.ai_notes || '',
    reviewDecision: p.review_decision || '', reviewNotes: p.review_notes || '', reviewedBy: await reviewerDisplayName(p.reviewed_by),
    answers, before, after, petBefore, petAfter, bids,
    proofSummary: String(p.proof_summary || '').trim(), proofPhotos, proofLink,
    galleryBase: `${baseUrlClean(opts.baseUrl)}/services/${encodeURIComponent(id)}/photos`,
    isInternal: opts.internal,
    variant: opts.variant,
  };
  return renderToBuffer(React.createElement(ServicePdf, { d }) as any);
}

const baseUrlClean = (u: string) => String(u || '').replace(/\/+$/, '');
