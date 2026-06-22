// pages/api/inspections/[id]/ai-review.ts
//
// AI review of a Scope rate card against the investment-property standard
// (SAFE / CLEAN / FUNCTIONAL) and the depreciation/tenant-responsibility rules.
//
// STREAMING: the server runs Claude with three tools — search_catalog (to find
// real codes for ADD suggestions), add_adjustment (one call per issue), and
// finish_review (the closing summary). As each add_adjustment tool block
// finishes generating it is normalized and pushed to the client over SSE, so
// the popup fills in suggestion-by-suggestion instead of all-at-once.
// Nothing is saved — the client applies approved adjustments via the normal
// rate-card-line + answers endpoints.

import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import { getSessionFromRequest } from '@/lib/auth';
import { recordAiUsage } from '@/lib/aiUsage';
import { matchCatalog } from '@/lib/voiceCatalogMatch';
import { calculateLine } from '@/lib/rateCardMath';
import { getCachedRegions } from '@/pages/api/rate-card/regions';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { AI_REVIEW_KNOWLEDGE } from '@/lib/aiReviewKnowledge';
import { getKnowledgeBasePromptText } from '@/lib/hubspot';
import { depreciationRates } from '@/lib/depreciation';
import type { RegionRate } from '@/lib/types';

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
  property?: { bedrooms?: number; bathrooms?: number; squareFootage?: number | null; tenantMonths?: number; lastTenantPetCount?: number | null };
  region?: string;
  ignoredLineIds?: string[];
}

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY is not set — AI review is unavailable.');
  return k;
}

function money(n: number): string {
  return `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// SSE helpers.
function sse(res: NextApiResponse, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function sseHeartbeat(res: NextApiResponse) {
  try { res.write(': keep-alive\n\n'); } catch { /* closed */ }
}

// Stream one Anthropic turn. Assembles content blocks; fires onToolComplete the
// moment a tool_use block finishes (so add_adjustment can be emitted live).
async function streamTurn(
  payload: any,
  onToolComplete: (block: any) => void,
): Promise<{ content: any[]; stopReason: string | null }> {
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => '');
    throw new Error(`AI review call failed ${resp.status}: ${t.slice(0, 200)}`);
  }
  const blocks: any[] = [];
  let stopReason: string | null = null;
  const toolJson: Record<number, string> = {};
  let usageIn = 0, usageOut = 0;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json || json === '[DONE]') continue;
      let ev: any;
      try { ev = JSON.parse(json); } catch { continue; }
      if (ev.type === 'message_start') {
        const u = ev.message?.usage;
        if (u) { usageIn += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); usageOut += u.output_tokens || 0; }
      } else if (ev.type === 'content_block_start') {
        const cb = ev.content_block;
        if (cb?.type === 'text') blocks[ev.index] = { type: 'text', text: '' };
        else if (cb?.type === 'tool_use') { blocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} }; toolJson[ev.index] = ''; }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta' && blocks[ev.index]) blocks[ev.index].text += d.text;
        else if (d?.type === 'input_json_delta') toolJson[ev.index] = (toolJson[ev.index] || '') + (d.partial_json || '');
      } else if (ev.type === 'content_block_stop') {
        const b = blocks[ev.index];
        if (b?.type === 'tool_use') {
          try { b.input = JSON.parse(toolJson[ev.index] || '{}'); } catch { b.input = {}; }
          try { onToolComplete(b); } catch { /* non-fatal */ }
        }
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens != null) usageOut = ev.usage.output_tokens; // cumulative
      }
    }
  }
  recordAiUsage({ source: 'ai_review', model: String(payload?.model || MODEL), inputTokens: usageIn, outputTokens: usageOut });
  return { content: blocks.filter(Boolean), stopReason };
}

// Fetch a photo URL → small base64 JPEG (or null if it can't be fetched/decoded).
async function fetchPhotoBlock(url: string): Promise<any | null> {
  try {
    const clean = url.split('#')[0]; // video entries are "poster#v=video"
    if (!/^https?:\/\//i.test(clean)) return null;
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
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to find, e.g. "blind replacement".' } }, required: ['query'] },
    },
    {
      name: 'add_adjustment',
      description: 'Report ONE suggested adjustment. Call this once per issue you find, as you find it (do not batch them). For an ADD, first call search_catalog and use a real code here.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['edit', 'remove', 'add'], description: 'edit = change an existing line; remove = delete one; add = propose a missing line.' },
          sectionId: { type: 'string', description: 'The room/section id this applies to.' },
          lineExternalId: { type: 'string', description: 'For edit/remove: the externalId of the target line (from the scope listing).' },
          title: { type: 'string', description: 'A SHORT imperative action, max ~6 words, saying what happens if approved — e.g. "Remove duplicate appliance clean", "Lower tenant to 50%", "Add blind replacement", "Move to Bathroom". No internal ids or line codes.' },
          rationale: { type: 'string', description: 'ONE short plain-language sentence (~15-20 words). NEVER include internal ids (voice_*, RCLINE-*, "id=..."), line codes, or raw dollar-math dumps — just the reason.' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          needsPhoto: { type: 'boolean', description: 'Set true when a damage / tenant-responsibility line is NOT supported by a photo. Use type "remove" with needsPhoto true so the inspector can either add a photo of the damage or remove the line.' },
          wrongRoom: { type: 'boolean', description: 'Set true when a line is simply in the WRONG room (e.g. a tub clean filed under Kitchen). Also set suggestedRoom to the correct room. Use type "edit" — the inspector will MOVE it, not delete it.' },
          suggestedRoom: { type: 'string', description: 'For wrongRoom: the correct room name (from the scope listing).' },
          suggestedLineItemCode: { type: 'string', description: 'For add (or an item swap): a real catalog code from search_catalog.' },
          suggestedQuantity: { type: 'number' },
          suggestedTenantBillBackPercent: { type: 'number', description: 'Suggested tenant % (0-100, steps of 5).' },
          suggestedVendorCost: { type: 'number', description: 'Suggested vendor cost override, if proposing a specific dollar amount.' },
          suggestedTenantDollars: { type: 'number', description: 'Resulting tenant $ after the change, if you can estimate it.' },
        },
        required: ['type', 'sectionId', 'title', 'rationale'],
      },
    },
    {
      name: 'finish_review',
      description: 'Call this LAST, exactly once, after all add_adjustment calls, with a one or two sentence summary of the outcome. If the scope is already compliant, call this with no prior add_adjustment calls and a summary saying it looks compliant.',
      input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  ];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const body = req.body as BodyShape;
    const sections = Array.isArray(body?.sections) ? body.sections : [];
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    const region = body?.region || '';
    const rawMonths = Number(body?.property?.tenantMonths);
    const tenantMonths = Number.isFinite(rawMonths) && rawMonths > 0 ? rawMonths : 12;
    const ignoredLineIds: string[] = Array.isArray(body?.ignoredLineIds) ? body.ignoredLineIds.map(String) : [];
    // Items the user already reviewed (decided on) in a prior run — never re-flag
    // them. Signatures are "line:<externalId>" or "add:<sectionId>:<code>".
    const reviewedSet = new Set<string>(Array.isArray((body as any)?.reviewedSignatures) ? (body as any).reviewedSignatures.map(String) : []);
    const reviewedLineIds = [...reviewedSet].filter((s) => s.startsWith('line:')).map((s) => s.slice(5));

    const catalog = await getCachedCatalog();
    const byCode = new Map(catalog.map((c) => [c.lineItemCode, c]));
    const regions = await getCachedRegions().catch(() => [] as RegionRate[]);
    const sectionById = new Map(sections.map((s) => [s.id, s]));

    // ---- Scope listing (priced authoritatively) ----
    const linesBySection = new Map<string, InLine[]>();
    for (const l of lines) { const a = linesBySection.get(l.sectionId) || []; a.push(l); linesBySection.set(l.sectionId, a); }
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
            quantity: l.quantity, tenantBillBackPercent: l.tenantBillBackPercent,
            customLaborRate: l.customLaborRate ?? null, customAdjustedMaterialCost: l.customAdjustedMaterialCost ?? null, customVendorCost: l.customVendorCost ?? null,
          });
          costStr = `vendor ${money(c.vendorCost)}, client ${money(c.clientCost)}, tenant ${money(c.tenantCost)}`;
          tenantStr = `${l.tenantBillBackPercent}% tenant = ${money(c.tenantCost)}`;
          if (/paint/i.test(item.category)) paintTotal += c.clientCost;
        } catch { /* noop */ }
        const bidTag = item.isBidItem
          ? ` | BID ITEM (${l.customVendorCost != null ? 'vendor cost set' : 'vendor cost NOT set'})`
          : '';
        rows.push(`    - id=${l.externalId} | ${item.laborShortDescription} [${item.category}/${item.subcategory}, ${item.laborMeas}] | qty ${l.quantity} | ${tenantStr} | ${costStr} | vendor: ${l.assignedTo || 'Vendor 1'}${bidTag}${l.note ? ` | note: ${l.note}` : ''}`);
      }
      if (rows.length) scopeBlocks.push(`  Room "${s.name}" (id=${s.id}):\n${rows.join('\n')}`);
    }

    const rawPetCount = Number(body?.property?.lastTenantPetCount);
    const lastTenantPetCount = Number.isFinite(rawPetCount) && rawPetCount >= 0 ? rawPetCount : null;
    const houseDetails = [
      `Bedrooms: ${body?.property?.bedrooms ?? '?'}, Bathrooms: ${body?.property?.bathrooms ?? '?'}, Square footage: ${body?.property?.squareFootage ?? '?'}`,
      `Region: ${region || 'unknown'}`,
      `Tenant time in home: ~${tenantMonths} months.`,
      `Last tenant pet count: ${lastTenantPetCount == null ? 'unknown' : lastTenantPetCount}${(lastTenantPetCount ?? 0) > 1 ? ' (MULTIPLE PETS — see the carpet replacement-vs-cleaning rule).' : ''}`,
      `DEPRECIATION SCHEDULE at ${tenantMonths} months → cap-eligible PAINT lines should be ${depreciationRates(tenantMonths).paint}% tenant, cap-eligible FLOORING lines ${depreciationRates(tenantMonths).flooring}% tenant. Apply these EXACT percentages to cap-eligible paint/flooring lines (whole-house paint, mist-match, normal-wear touchups; carpet/pad/LVP/tile/grout flooring material). Do NOT cap tenant-damage paint patches, removals, fixtures, bulbs, or cleaning. Flag cap-eligible lines whose tenant % differs and suggest the scheduled %.`,
      `Sum of all PAINT line client costs so far: ${money(paintTotal)} (compare against a whole-house mist-match Level 1/2).`,
    ].join('\n');

    // ---- Photos (downsized), all fetched in parallel, grouped by room ----
    const photosBySection = body?.photosBySection || {};
    const picks: { sectionId: string; sectionName: string; url: string }[] = [];
    for (const s of sections) {
      if (picks.length >= MAX_PHOTOS_TOTAL) break;
      const urls = (photosBySection[s.id] || []).filter((u) => /^https?:\/\//i.test(u.split('#')[0]));
      for (const url of urls.slice(-MAX_PHOTOS_PER_ROOM)) { if (picks.length >= MAX_PHOTOS_TOTAL) break; picks.push({ sectionId: s.id, sectionName: s.name, url }); }
    }
    const fetched = await Promise.all(picks.map((p) => fetchPhotoBlock(p.url)));
    const photoContent: any[] = [];
    let lastSection = '';
    for (let i = 0; i < picks.length; i++) {
      const block = fetched[i];
      if (!block) continue;
      if (picks[i].sectionId !== lastSection) { photoContent.push({ type: 'text', text: `Photos for room "${picks[i].sectionName}" (id=${picks[i].sectionId}):` }); lastSection = picks[i].sectionId; }
      photoContent.push(block);
    }

    const scopeText = scopeBlocks.length ? scopeBlocks.join('\n\n') : '(No line items have been added yet.)';
    const userContent: any[] = [
      {
        type: 'text',
        text:
          `Review this Scope rate card.\n\nHOUSE DETAILS:\n${houseDetails}\n\nSCOPE (all rooms and their line items, priced):\n${scopeText}\n\n` +
          (photoContent.length ? `Inspection photos for the rooms follow — use them to confirm scope and tenant responsibility.` : `No usable inspection photos were available; review on the scope data.`) +
          (ignoredLineIds.length ? `\n\nDo NOT raise photo-evidence (needsPhoto) flags for these line ids — the inspector has already accepted them without a photo: ${ignoredLineIds.join(', ')}.` : '') +
          (reviewedLineIds.length ? `\n\nThese line ids were already reviewed and decided on in a PRIOR pass — do NOT flag them again: ${reviewedLineIds.join(', ')}.` : '') +
          `\n\nAnalyze against the standard and rules in the system prompt. Call add_adjustment once per issue as you find it (for ADDs, search_catalog first for a real code). Provide suggested tenant % AND $ where possible. When finished, call finish_review with a short summary. If the scope is already compliant, just call finish_review.`,
      },
      ...photoContent,
    ];

    // Cache the per-review scope + photos so the 4-round tool loop re-reads this
    // (often photo-heavy) message at ~0.1x instead of full price each round.
    if (userContent.length) (userContent[userContent.length - 1] as any).cache_control = { type: 'ephemeral' };

    const messages: any[] = [{ role: 'user', content: userContent }];
    const reviewTools = tools();

    // Normalize a model add_adjustment into the client AiAdjustment shape,
    // enriching from the catalog and pricing current/suggested values.
    let adjIdx = 0;
    const normalize = (a: any) => {
      const type = a?.type === 'remove' ? 'remove' : a?.type === 'add' ? 'add' : 'edit';
      const sectionId = String(a?.sectionId || '');
      const section = sectionById.get(sectionId);
      const lineExternalId = a?.lineExternalId ? String(a.lineExternalId) : undefined;
      const cur = lineExternalId ? lines.find((l) => l.externalId === lineExternalId) : undefined;

      let current: any = undefined;
      if (cur) {
        const item = byCode.get(cur.lineItemCode);
        let tenantDollars: number | undefined; let vendorCost: number | undefined;
        try { if (item) { const c = calculateLine(item, region, regions, { quantity: cur.quantity, tenantBillBackPercent: cur.tenantBillBackPercent, customVendorCost: cur.customVendorCost ?? null }); tenantDollars = c.tenantCost; vendorCost = c.vendorCost; } } catch { /* noop */ }
        current = { description: item?.laborShortDescription || cur.lineItemCode, quantity: cur.quantity, tenantBillBackPercent: cur.tenantBillBackPercent, tenantDollars, vendorCost, unit: item?.laborMeas, lineItemCode: cur.lineItemCode };
      }

      const sCode = a?.suggestedLineItemCode ? String(a.suggestedLineItemCode) : undefined;
      const sItem = sCode ? byCode.get(sCode) : (cur ? byCode.get(cur.lineItemCode) : undefined);
      const suggested: any = {};
      if (sCode && byCode.has(sCode)) { suggested.lineItemCode = sCode; suggested.description = sItem?.laborShortDescription; suggested.unit = sItem?.laborMeas; }
      if (a?.suggestedQuantity != null && isFinite(Number(a.suggestedQuantity))) suggested.quantity = Number(a.suggestedQuantity);
      // Unit-swap quantity guard: when the suggestion swaps to a line item with a
      // DIFFERENT unit of measure than the current line (e.g. a per-SF scope
      // downgraded to a per-EA whole-house clean), the old quantity must NOT carry
      // over — a 1,685 SF line otherwise became "1,685 EA cleans" priced at $339k.
      // Default the swapped line to qty 1 unless the model gave an explicit one.
      if (suggested.lineItemCode && suggested.quantity == null) {
        const curUnit = ((cur ? byCode.get(cur.lineItemCode)?.laborMeas : '') || '').trim().toUpperCase();
        const newUnit = (sItem?.laborMeas || '').trim().toUpperCase();
        if (!cur || curUnit !== newUnit) suggested.quantity = 1;
      }
      if (a?.suggestedTenantBillBackPercent != null && isFinite(Number(a.suggestedTenantBillBackPercent))) suggested.tenantBillBackPercent = Math.max(0, Math.min(100, Math.round(Number(a.suggestedTenantBillBackPercent) / 5) * 5));
      if (a?.suggestedVendorCost != null && isFinite(Number(a.suggestedVendorCost))) suggested.customVendorCost = Number(a.suggestedVendorCost);
      // NOTE: vendor reassignment intentionally NOT applied — the AI review must
      // never change a line's assigned vendor (keep the inspector's choice).

      let suggestedTenantDollars: number | undefined = a?.suggestedTenantDollars != null ? Number(a.suggestedTenantDollars) : undefined;
      try {
        if (type !== 'remove' && sItem) {
          const qty = suggested.quantity ?? cur?.quantity ?? 1;
          const pct = suggested.tenantBillBackPercent ?? cur?.tenantBillBackPercent ?? 100;
          const c = calculateLine(sItem, region, regions, { quantity: qty, tenantBillBackPercent: pct, customVendorCost: suggested.customVendorCost ?? cur?.customVendorCost ?? null });
          suggestedTenantDollars = c.tenantCost;
        }
      } catch { /* keep model estimate */ }

      // Wrong-room: a line filed in the wrong room. Treat it as a move (the
      // inspector picks the destination room from a dropdown). Inferred from the
      // explicit flag OR a "Move …" title (the model sometimes titles a move
      // without setting the flag). Resolve the suggested target when we can.
      const wrongRoom = a?.wrongRoom === true || /^\s*move\b/i.test(String(a?.title || ''));
      if (wrongRoom) {
        const want = String(a?.suggestedRoom || '').trim().toLowerCase();
        if (want) {
          const target = sections.find((s) => s.name.toLowerCase() === want)
            || sections.find((s) => s.name.toLowerCase().includes(want) || want.includes(s.name.toLowerCase()));
          if (target && target.id !== sectionId) { suggested.moveToSectionId = target.id; suggested.moveToRoomName = target.name; }
        }
      }

      const norm = {
        id: `aiadj_${adjIdx++}_${Math.random().toString(36).slice(2, 7)}`,
        type, sectionId, sectionName: section?.name, lineExternalId,
        title: String(a?.title || 'Suggested adjustment'),
        rationale: String(a?.rationale || ''),
        severity: ['high', 'medium', 'low'].includes(a?.severity) ? a.severity : 'medium',
        needsPhoto: a?.needsPhoto === true,
        wrongRoom,
        current,
        suggested: Object.keys(suggested).length ? suggested : undefined,
        suggestedTenantDollars: suggestedTenantDollars != null && isFinite(suggestedTenantDollars) ? suggestedTenantDollars : undefined,
      };
      // Skip items already reviewed/decided in a prior pass (hard dedup across
      // re-reviews — signature must match the client's reviewSignature()).
      const sig = norm.lineExternalId
        ? `line:${norm.lineExternalId}`
        : `add:${norm.sectionId || ''}:${norm.suggested?.lineItemCode || ''}`;
      if (reviewedSet.has(sig)) return null;
      // Validity: edit/remove need a resolvable target; add needs a real code.
      const valid = norm.type === 'add' ? !!norm.suggested?.lineItemCode : (!!norm.lineExternalId && lines.some((l) => l.externalId === norm.lineExternalId));
      return valid ? norm : null;
    };

    // The editable AI Knowledge Base (operator rules + curated worked examples)
    // drives reasoning on EVERY AI surface — fold it into the review's system
    // prompt too so house rules (e.g. tenant-% conventions) shape the review.
    const reviewKb = await getKnowledgeBasePromptText().catch(() => '');
    const reviewSystemText = reviewKb
      ? `${AI_REVIEW_KNOWLEDGE}\n\nOPERATOR KNOWLEDGE BASE — house rules and worked examples curated by the team. Treat as authoritative:\n${reviewKb}`
      : AI_REVIEW_KNOWLEDGE;

    let finished = false;
    // The breakpoint on the most-recently-appended tool_results, so the growing
    // conversation prefix is cache-read on the next round (the model otherwise
    // re-processes every prior turn each round). We MOVE it forward each round
    // (clearing the previous one) to stay well under Anthropic's 4-breakpoint
    // cap: system(1) + initial user(1) + latest tool_results(1).
    let lastCachedToolBlock: any = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS && !finished; round++) {
      sseHeartbeat(res);
      const { content } = await streamTurn(
        {
          // Cache the knowledge base + tools (tools render before system, so a
          // breakpoint on the system block caches both together). Re-read at
          // ~0.1x on rounds 2-4 of this loop and across reviews within the TTL.
          model: MODEL, max_tokens: 4000,
          system: [{ type: 'text', text: reviewSystemText, cache_control: { type: 'ephemeral' } }],
          tools: reviewTools,
          tool_choice: round === MAX_TOOL_ROUNDS - 1 ? { type: 'tool', name: 'finish_review' } : { type: 'auto' },
          messages,
        },
        // Emit each adjustment / the summary the instant its tool block completes.
        (block) => {
          if (block?.name === 'add_adjustment') {
            const n = normalize(block.input);
            if (n) sse(res, 'adjustment', n);
          } else if (block?.name === 'finish_review') {
            sse(res, 'summary', { summary: String(block.input?.summary || '') });
            finished = true;
          }
        },
      );

      const toolUses = content.filter((c: any) => c.type === 'tool_use');
      if (toolUses.length === 0) { finished = true; break; }
      if (finished) break; // finish_review seen — we have everything

      // Otherwise we must answer the tool calls to continue (e.g. search_catalog).
      messages.push({ role: 'assistant', content });
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        if (tu.name === 'search_catalog') {
          const q = String(tu.input?.query || '');
          const m = await matchCatalog(q, catalog, { topK: 6 }).catch(() => null);
          const payload = m
            ? { confident: m.confident, candidates: m.candidates.map((c) => ({ code: c.item.lineItemCode, description: c.item.laborShortDescription, category: c.item.category, unit: c.item.laborMeas })) }
            : { confident: false, candidates: [] };
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(payload) });
        } else {
          // add_adjustment already streamed — just acknowledge so the model can continue.
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'recorded' });
        }
      }
      // Cache the conversation through this round: put the breakpoint on the
      // latest tool_results block and clear the previous one (keeps breakpoints
      // bounded; reads still match the longest previously-written prefix).
      if (lastCachedToolBlock) { delete lastCachedToolBlock.cache_control; lastCachedToolBlock = null; }
      if (toolResults.length) {
        toolResults[toolResults.length - 1].cache_control = { type: 'ephemeral' };
        lastCachedToolBlock = toolResults[toolResults.length - 1];
      }
      messages.push({ role: 'user', content: toolResults });
    }

    sse(res, 'done', {});
    return res.end();
  } catch (e: any) {
    console.error('POST /api/inspections/[id]/ai-review failed:', e);
    try { sse(res, 'error', { error: String(e?.message || e) }); sse(res, 'done', {}); return res.end(); }
    catch { return res.status(500).json({ error: String(e?.message || e) }); }
  }
}
