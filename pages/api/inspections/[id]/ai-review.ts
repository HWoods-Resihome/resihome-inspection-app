// pages/api/inspections/[id]/ai-review.ts
//
// AI review of a Scope rate card against the investment-property standard
// (SAFE / CLEAN / FUNCTIONAL) and the depreciation/tenant-responsibility rules.
//
// One POST per review. The client sends the current scope (all rooms + lines)
// and the room photos (as URLs). The server prices each line authoritatively
// (calculateLine), fetches+downsizes the photos, and runs Claude with two
// tools: search_catalog (to propose real catalog codes for ADD suggestions)
// and submit_review (the structured result). It returns { summary, adjustments }.
// Nothing is saved — the client applies approved adjustments via the normal
// rate-card-line + answers endpoints.

import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchRateCardCatalog } from '@/lib/hubspot';
import { matchCatalog } from '@/lib/voiceCatalogMatch';
import { calculateLine } from '@/lib/rateCardMath';
import { getCachedRegions } from '@/pages/api/rate-card/regions';
import { AI_REVIEW_KNOWLEDGE } from '@/lib/aiReviewKnowledge';
import type { RateCardLineItem, RegionRate } from '@/lib/types';

export const config = { maxDuration: 120, api: { bodyParser: { sizeLimit: '2mb' } } };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_ROUNDS = 4;
// Photo budget — keep token cost (and latency) bounded. The newest few per room
// are the most relevant to the current scope. Smaller + fewer = faster review.
const MAX_PHOTOS_PER_ROOM = 2;
const MAX_PHOTOS_TOTAL = 12;
const PHOTO_EDGE = 448; // px, long edge after downscale

interface InLine {
  sectionId: string;
  externalId: string;
  lineItemCode: string;
  quantity: number;
  tenantBillBackPercent: number;
  assignedTo?: string;
  note?: string;
  customVendorCost?: number | null;
  customLaborRate?: number | null;
  customAdjustedMaterialCost?: number | null;
}
interface InSection { id: string; name: string; location?: string }
interface BodyShape {
  sections: InSection[];
  lines: InLine[];
  photosBySection?: Record<string, string[]>;
  property?: { bedrooms?: number; bathrooms?: number; squareFootage?: number | null; tenantMonths?: number };
  region?: string;
}

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY is not set — AI review is unavailable.');
  return k;
}

function money(n: number): string {
  return `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function callAnthropic(payload: any): Promise<{ content: any[]; stopReason: string | null }> {
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`AI review call failed ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  return { content: data.content || [], stopReason: data.stop_reason || null };
}

// Fetch a photo URL and return a small base64 JPEG for the model, or null if it
// can't be fetched/decoded (offline drafts, dead links, videos w/o poster).
async function fetchPhotoBlock(url: string): Promise<any | null> {
  try {
    // Video entries are "poster#v=video"; use the poster image.
    const clean = url.split('#')[0];
    if (!/^https?:\/\//i.test(clean)) return null; // blob: drafts can't be fetched server-side
    const r = await fetch(clean);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const jpeg = await sharp(buf).rotate().resize(PHOTO_EDGE, PHOTO_EDGE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
  } catch {
    return null;
  }
}

function tools() {
  return [
    {
      name: 'search_catalog',
      description: 'Semantic search of the rate-card catalog. Use ONLY when proposing an ADD adjustment, to find the real line item code for a missing scope. Returns candidate codes with unit + category.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to find, e.g. "blind replacement" or "sales clean".' } },
        required: ['query'],
      },
    },
    {
      name: 'submit_review',
      description: 'Return your FINAL review. Call this exactly once when analysis is complete. If the scope is already compliant, return an empty adjustments array and a one-line summary saying so.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One or two sentences summarizing the review outcome.' },
          adjustments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['edit', 'remove', 'add'], description: 'edit = change an existing line; remove = delete one; add = propose a missing line.' },
                sectionId: { type: 'string', description: 'The room/section id this applies to.' },
                lineExternalId: { type: 'string', description: 'For edit/remove: the externalId of the target line (from the scope listing).' },
                title: { type: 'string', description: 'Short headline of the suggestion.' },
                rationale: { type: 'string', description: 'Why, citing the relevant rule (depreciation cap, duplicate, beyond safe/clean/functional, tenant responsibility, etc.).' },
                severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                suggestedLineItemCode: { type: 'string', description: 'For add (or an item swap): a real catalog code from search_catalog.' },
                suggestedQuantity: { type: 'number' },
                suggestedTenantBillBackPercent: { type: 'number', description: 'Suggested tenant % (0-100, steps of 5).' },
                suggestedVendorCost: { type: 'number', description: 'Suggested vendor cost override, if proposing a specific dollar amount.' },
                suggestedAssignedTo: { type: 'string' },
                suggestedTenantDollars: { type: 'number', description: 'Resulting tenant $ after the change, if you can estimate it.' },
              },
              required: ['type', 'sectionId', 'title', 'rationale'],
            },
          },
        },
        required: ['summary', 'adjustments'],
      },
    },
  ];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body as BodyShape;
    const sections = Array.isArray(body?.sections) ? body.sections : [];
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    const region = body?.region || '';
    // Default to 12 months whenever the property field is missing, null, or invalid.
    const rawMonths = Number(body?.property?.tenantMonths);
    const tenantMonths = Number.isFinite(rawMonths) && rawMonths >= 0 ? rawMonths : 12;

    const catalog = await fetchRateCardCatalog();
    const byCode = new Map(catalog.map((c) => [c.lineItemCode, c]));
    const regions = await getCachedRegions().catch(() => [] as RegionRate[]);
    const sectionById = new Map(sections.map((s) => [s.id, s]));

    // ---- Build the scope listing (priced authoritatively) ----
    const linesBySection = new Map<string, InLine[]>();
    for (const l of lines) {
      const arr = linesBySection.get(l.sectionId) || [];
      arr.push(l);
      linesBySection.set(l.sectionId, arr);
    }

    const scopeBlocks: string[] = [];
    let paintTotal = 0;
    for (const s of sections) {
      const secLines = linesBySection.get(s.id) || [];
      if (secLines.length === 0) continue;
      const rows: string[] = [];
      for (const l of secLines) {
        const item = byCode.get(l.lineItemCode);
        if (!item) continue;
        let costStr = '';
        let tenantStr = `${l.tenantBillBackPercent}% tenant`;
        try {
          const c = calculateLine(item, region, regions, {
            quantity: l.quantity,
            tenantBillBackPercent: l.tenantBillBackPercent,
            customLaborRate: l.customLaborRate ?? null,
            customAdjustedMaterialCost: l.customAdjustedMaterialCost ?? null,
            customVendorCost: l.customVendorCost ?? null,
          });
          costStr = `vendor ${money(c.vendorCost)}, client ${money(c.clientCost)}, tenant ${money(c.tenantCost)}`;
          tenantStr = `${l.tenantBillBackPercent}% tenant = ${money(c.tenantCost)}`;
          if (/paint/i.test(item.category)) paintTotal += c.clientCost;
        } catch { /* keep going without cost */ }
        rows.push(
          `    - id=${l.externalId} | ${item.laborShortDescription} [${item.category}/${item.subcategory}, ${item.laborMeas}] | qty ${l.quantity} | ${tenantStr} | ${costStr} | vendor: ${l.assignedTo || 'Vendor 1'}${l.note ? ` | note: ${l.note}` : ''}`
        );
      }
      if (rows.length) {
        scopeBlocks.push(`  Room "${s.name}" (id=${s.id}):\n${rows.join('\n')}`);
      }
    }

    // ---- House details block ----
    const houseDetails = [
      `Bedrooms: ${body?.property?.bedrooms ?? '?'}, Bathrooms: ${body?.property?.bathrooms ?? '?'}, Square footage: ${body?.property?.squareFootage ?? '?'}`,
      `Region: ${region || 'unknown'}`,
      `Tenant time in home: ~${tenantMonths} months (use for depreciation on cap-eligible scopes only).`,
      `Sum of all PAINT line client costs so far: ${money(paintTotal)} (compare against a whole-house mist-match Level 1/2).`,
    ].join('\n');

    // ---- Photos (downsized), grouped by room, capped ----
    // Build the capped pick list first, then fetch+downsize ALL of them in
    // parallel (the slow part), then group — much faster than awaiting per room.
    const photosBySection = body?.photosBySection || {};
    const picks: { sectionId: string; sectionName: string; url: string }[] = [];
    for (const s of sections) {
      if (picks.length >= MAX_PHOTOS_TOTAL) break;
      const urls = (photosBySection[s.id] || []).filter((u) => /^https?:\/\//i.test(u.split('#')[0]));
      for (const url of urls.slice(-MAX_PHOTOS_PER_ROOM)) {
        if (picks.length >= MAX_PHOTOS_TOTAL) break;
        picks.push({ sectionId: s.id, sectionName: s.name, url });
      }
    }
    const fetched = await Promise.all(picks.map((p) => fetchPhotoBlock(p.url)));
    const photoContent: any[] = [];
    let lastSection = '';
    for (let i = 0; i < picks.length; i++) {
      const block = fetched[i];
      if (!block) continue;
      if (picks[i].sectionId !== lastSection) {
        photoContent.push({ type: 'text', text: `Photos for room "${picks[i].sectionName}" (id=${picks[i].sectionId}):` });
        lastSection = picks[i].sectionId;
      }
      photoContent.push(block);
    }

    const scopeText = scopeBlocks.length
      ? scopeBlocks.join('\n\n')
      : '(No line items have been added yet.)';

    const userContent: any[] = [
      {
        type: 'text',
        text:
          `Review this Scope rate card.\n\nHOUSE DETAILS:\n${houseDetails}\n\nSCOPE (all rooms and their line items, priced):\n${scopeText}\n\n` +
          (photoContent.length
            ? `Inspection photos for the rooms follow — use them to confirm scope and tenant responsibility.`
            : `No usable inspection photos were available; review on the scope data.`) +
          `\n\nAnalyze against the standard and rules in the system prompt. Then call submit_review with every adjustment (type edit/remove/add). For ADD suggestions, first call search_catalog to get a real line item code. Provide suggested tenant % AND suggested tenant $ where possible. If the scope is already compliant, submit an empty adjustments list.`,
      },
      ...photoContent,
    ];

    const messages: any[] = [{ role: 'user', content: userContent }];
    const reviewTools = tools();

    let result: { summary: string; adjustments: any[] } | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS && !result; round++) {
      const { content } = await callAnthropic({
        model: MODEL,
        max_tokens: 4000,
        system: AI_REVIEW_KNOWLEDGE,
        tools: reviewTools,
        tool_choice: round === MAX_TOOL_ROUNDS - 1 ? { type: 'tool', name: 'submit_review' } : { type: 'auto' },
        messages,
      });
      const toolUses = content.filter((c: any) => c.type === 'tool_use');
      if (toolUses.length === 0) break; // model replied with text only; stop

      messages.push({ role: 'assistant', content });
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        if (tu.name === 'submit_review') {
          result = { summary: String(tu.input?.summary || ''), adjustments: Array.isArray(tu.input?.adjustments) ? tu.input.adjustments : [] };
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'received' });
        } else if (tu.name === 'search_catalog') {
          const q = String(tu.input?.query || '');
          const m = await matchCatalog(q, catalog, { topK: 6 }).catch(() => null);
          const payload = m
            ? { confident: m.confident, candidates: m.candidates.map((c) => ({ code: c.item.lineItemCode, description: c.item.laborShortDescription, category: c.item.category, unit: c.item.laborMeas })) }
            : { confident: false, candidates: [] };
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(payload) });
        } else {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Unknown tool' });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }

    if (!result) {
      return res.status(200).json({ summary: 'The review could not be completed automatically. Please review the scope manually.', adjustments: [] });
    }

    // ---- Normalize into AiAdjustment[] (enrich from catalog + priced current) ----
    const normalize = (a: any, idx: number) => {
      const type = a?.type === 'remove' ? 'remove' : a?.type === 'add' ? 'add' : 'edit';
      const sectionId = String(a?.sectionId || '');
      const section = sectionById.get(sectionId);
      const lineExternalId = a?.lineExternalId ? String(a.lineExternalId) : undefined;
      const cur = lineExternalId ? lines.find((l) => l.externalId === lineExternalId) : undefined;

      // current snapshot (edit/remove)
      let current: any = undefined;
      if (cur) {
        const item = byCode.get(cur.lineItemCode);
        let tenantDollars: number | undefined;
        let vendorCost: number | undefined;
        try {
          if (item) {
            const c = calculateLine(item, region, regions, { quantity: cur.quantity, tenantBillBackPercent: cur.tenantBillBackPercent, customVendorCost: cur.customVendorCost ?? null });
            tenantDollars = c.tenantCost; vendorCost = c.vendorCost;
          }
        } catch { /* noop */ }
        current = {
          description: item?.laborShortDescription || cur.lineItemCode,
          quantity: cur.quantity,
          tenantBillBackPercent: cur.tenantBillBackPercent,
          tenantDollars,
          vendorCost,
          unit: item?.laborMeas,
          lineItemCode: cur.lineItemCode,
        };
      }

      // suggested
      const sCode = a?.suggestedLineItemCode ? String(a.suggestedLineItemCode) : undefined;
      const sItem = sCode ? byCode.get(sCode) : (cur ? byCode.get(cur.lineItemCode) : undefined);
      const suggested: any = {};
      if (sCode && byCode.has(sCode)) { suggested.lineItemCode = sCode; suggested.description = sItem?.laborShortDescription; suggested.unit = sItem?.laborMeas; }
      if (a?.suggestedQuantity != null && isFinite(Number(a.suggestedQuantity))) suggested.quantity = Number(a.suggestedQuantity);
      if (a?.suggestedTenantBillBackPercent != null && isFinite(Number(a.suggestedTenantBillBackPercent))) {
        suggested.tenantBillBackPercent = Math.max(0, Math.min(100, Math.round(Number(a.suggestedTenantBillBackPercent) / 5) * 5));
      }
      if (a?.suggestedVendorCost != null && isFinite(Number(a.suggestedVendorCost))) suggested.customVendorCost = Number(a.suggestedVendorCost);
      if (a?.suggestedAssignedTo) suggested.assignedTo = String(a.suggestedAssignedTo);

      // Estimate resulting tenant $ when we can.
      let suggestedTenantDollars: number | undefined = a?.suggestedTenantDollars != null ? Number(a.suggestedTenantDollars) : undefined;
      try {
        const baseItem = sItem;
        if (type !== 'remove' && baseItem) {
          const qty = suggested.quantity ?? cur?.quantity ?? 1;
          const pct = suggested.tenantBillBackPercent ?? cur?.tenantBillBackPercent ?? 100;
          const c = calculateLine(baseItem, region, regions, { quantity: qty, tenantBillBackPercent: pct, customVendorCost: suggested.customVendorCost ?? cur?.customVendorCost ?? null });
          suggestedTenantDollars = c.tenantCost;
        }
      } catch { /* keep model's estimate */ }

      return {
        id: `aiadj_${idx}_${Math.random().toString(36).slice(2, 7)}`,
        type,
        sectionId,
        sectionName: section?.name,
        lineExternalId,
        title: String(a?.title || 'Suggested adjustment'),
        rationale: String(a?.rationale || ''),
        severity: ['high', 'medium', 'low'].includes(a?.severity) ? a.severity : 'medium',
        current,
        suggested: Object.keys(suggested).length ? suggested : undefined,
        suggestedTenantDollars: suggestedTenantDollars != null && isFinite(suggestedTenantDollars) ? suggestedTenantDollars : undefined,
      };
    };

    // Drop invalid ones (edit/remove without a resolvable target, add without a valid code).
    const adjustments = result.adjustments
      .map(normalize)
      .filter((a) => {
        if (a.type === 'add') return !!a.suggested?.lineItemCode;
        return !!a.lineExternalId && lines.some((l) => l.externalId === a.lineExternalId);
      });

    return res.status(200).json({ summary: result.summary, adjustments });
  } catch (e: any) {
    console.error('POST /api/inspections/[id]/ai-review failed:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
