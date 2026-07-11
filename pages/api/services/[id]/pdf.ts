/**
 * GET /api/services/[id]/pdf — render a Service Work Order completion PDF inline.
 * Available once the service has been submitted. Services-gated. Photos are
 * fetched + downscaled to data URIs so react-pdf renders them reliably server-side.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { fetchServiceWorkOrder, readServiceForms } from '@/lib/hubspot';
import { worktypeLabel, subtypeLabel, type Worktype } from '@/lib/services/worktypes';
import { SAMPLE_FORMS, formKey } from '@/lib/services/serviceForms';
import { ServicePdf, type ServicePdfData } from '@/lib/servicePdf';

export const config = { maxDuration: 60 };

const money = (v: any) => { const n = Number(v); return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''; };
const splitUrls = (v: any): string[] => String(v || '').split(/[\n,]+/).map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x.split('#')[0]));
const normDate = (v: any): string => { const t = String(v ?? '').trim(); if (!t) return ''; if (/^\d{10,}$/.test(t)) return new Date(Number(t)).toISOString().slice(0, 10); return t.slice(0, 10); };

async function toDataUri(url: string): Promise<string | null> {
  try {
    const r = await fetch(url.split('#')[0]);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const jpeg = await sharp(buf).rotate().resize(360, 360, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 62 }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch { return null; }
}
async function encodeAll(urls: string[], cap = 8): Promise<string[]> {
  const out = await Promise.all(urls.slice(0, cap).map(toDataUri));
  return out.filter((x): x is string => !!x);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not available' });
  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'PDF is available for live services only.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(404).json({ error: 'Service not found.' });
    const p = rec.props;
    const worktype = (p.worktype || '') as Worktype;
    const subtype = p.subtype || '';
    const answersRaw = (() => { try { return JSON.parse(p.answers_json || '{}'); } catch { return {}; } })();
    const savedForms = await readServiceForms().catch(() => null);
    const form = ({ ...SAMPLE_FORMS, ...(savedForms || {}) })[formKey(worktype, subtype)] || [];
    const answers = form
      .filter((q) => answersRaw[q.id] != null && answersRaw[q.id] !== '')
      .map((q) => ({ label: q.label, value: Array.isArray(answersRaw[q.id]) ? answersRaw[q.id].join(', ') : String(answersRaw[q.id]) }));

    const [before, after, petBefore, petAfter] = await Promise.all([
      encodeAll(splitUrls(p.before_photo_urls)), encodeAll(splitUrls(p.after_photo_urls)),
      encodeAll(splitUrls(p.pet_before_photo_urls)), encodeAll(splitUrls(p.pet_after_photo_urls)),
    ]);

    const d: ServicePdfData = {
      address: p.address_snapshot || p.service_name || '(Service)', locality: p.locality_snapshot || '',
      worktype: worktypeLabel(worktype), subtype: subtypeLabel(worktype, subtype),
      scope: p.scope === 'community' ? 'Community' : 'SFR', vendor: p.vendor_name || '',
      status: p.status || '', dueDate: normDate(p.due_date), submittedAt: normDate(p.submitted_at), completedAt: normDate(p.completed_at),
      vendorCost: money(p.vendor_cost), markupPct: p.markup_pct != null ? String(p.markup_pct) : '', clientCost: money(p.client_cost),
      adjustment: p.vendor_cost_adjustment && Number(p.vendor_cost_adjustment) > 0 ? money(p.vendor_cost_adjustment) : '', adjustmentReason: p.vendor_cost_adjustment_reason || '',
      aiVerdict: p.ai_verdict || '', aiNotes: p.ai_notes || '',
      reviewDecision: p.review_decision || '', reviewNotes: p.review_notes || '', reviewedBy: p.reviewed_by || '',
      answers, before, after, petBefore, petAfter,
      galleryBase: `${(req.headers['x-forwarded-proto'] as string) || 'https'}://${req.headers.host || ''}/services/${encodeURIComponent(id)}/photos`,
    };

    const buffer = await renderToBuffer(React.createElement(ServicePdf, { d }) as any);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="service-${id}.pdf"`);
    return res.status(200).send(buffer);
  } catch (e: any) {
    console.error('GET /api/services/[id]/pdf failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
