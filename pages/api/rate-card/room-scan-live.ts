// Live Room Scan (Phase 3) — fast incremental vision for the in-camera flow.
//
// Called repeatedly (every couple seconds) while the inspector pans the room.
// Each call sends ONE downscaled keyframe + the latest voice-over delta + the
// list of items already surfaced, and returns ONLY the NEW call-outs. It runs
// on the fast model (Haiku), single-pass, low token ceiling, so the round-trip
// stays well under the sampling interval and chips feel near-instant.
//
// Same scope rules and catalog resolution as /room-scan; just tuned for speed
// and de-duplication across a continuous session.

import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import { getSessionFromRequest } from '@/lib/auth';
import { matchCatalog } from '@/lib/voiceCatalogMatch';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { depKindForCategory, depreciationTenantPct } from '@/lib/depreciation';
import { VENDORS } from '@/lib/vendors';

export const config = {
  maxDuration: 30,
  api: { bodyParser: { sizeLimit: '4mb' } },
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_FAST = 'claude-haiku-4-5-20251001';
const FRAME_EDGE = 640;   // small frame = fast upload + fast inference

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY is not set.');
  return k;
}

const SYSTEM = [
  'You are a move-out scope reviewer watching a LIVE camera pan of one room. You get the current frame, any new voice-over, the items ALREADY on screen this session, and the items still PENDING the inspector\'s decision.',
  'STANDARD: SAFE, CLEAN, FUNCTIONAL — no luxury. QUALITY OVER QUANTITY: only call out work with clear visible evidence in THIS frame, or that the inspector just said. Most frames warrant ZERO new items — that is correct. Never invent work.',
  'Do NOT repeat anything in the already-suggested list (or near-duplicates).',
  'TWO things you can do, both via tools, all in one response (often neither):',
  ' • suggest_line — a genuinely NEW item seen or just called out.',
  ' • edit_line — the inspector is amending a PENDING item by voice. Use the pending list + transcript. Examples: "make it two walls" -> quantity 2 on the wall-paint item; "whole room" / "paint the whole room" -> scopeQuery "whole room paint" on that item; "assign that to PPW" -> vendor "PPW"; "fifty percent tenant" -> tenantPct 50. Set targetId to the pending item being amended.',
  'NO loose inferences (a cluttered vanity is not "clean the tub"). Match the line item to the actual issue.',
  'BLINDS: a broken/missing/damaged blind is ALWAYS a FAUX WOOD BLIND replacement — query EXACTLY "replace faux wood blind". NEVER a valance, vertical blind, or wand unless the inspector names that exact part.',
  'MEASURED items (SF/LF): set quantityStated=true + number ONLY if the inspector stated it; otherwise quantityStated=false and give estimatedQuantity — a rough size from the apparent room (a draft the inspector confirms). Never imply precision.',
  'COUNT/EA items: quantity=1, quantityStated=true.',
].join('\n');

const EDIT_TOOL = {
  name: 'edit_line',
  description: 'Amend a PENDING (not-yet-added) item the inspector is changing by voice. Only for items in the pending list.',
  input_schema: {
    type: 'object',
    properties: {
      targetId: { type: 'string', description: 'id of the pending item being amended.' },
      quantity: { type: 'number', description: 'New quantity (e.g. 2 walls -> 2).' },
      scopeQuery: { type: 'string', description: 'New catalog search phrase if the SCOPE changed (e.g. "whole room paint", "whole house mist match"). We re-resolve the code.' },
      vendor: { type: 'string', description: 'New vendor name if reassigned (must be one of the allowed vendors).' },
      tenantPct: { type: 'number', description: 'New tenant bill-back percent 0-100 if the inspector stated one.' },
    },
    required: ['targetId'],
  },
};

const SUGGEST_TOOL = {
  name: 'suggest_line',
  description: 'Propose ONE NEW line item seen in the current frame or just called out. Skip anything already suggested.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Short catalog search phrase for the work.' },
      category: { type: 'string', description: 'Best-guess category.' },
      quantity: { type: 'number' },
      quantityStated: { type: 'boolean' },
      estimatedQuantity: { type: 'number', description: 'Rough size for measured items the inspector did not state (pre-fill, to be confirmed).' },
      rationale: { type: 'string', description: 'One short sentence of evidence.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['query', 'rationale'],
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const body = req.body || {};
    const sectionName: string = String(body.sectionName || 'this room');
    const tenantMonths: number = (typeof body.tenantMonths === 'number' && body.tenantMonths > 0) ? body.tenantMonths : 12;
    const transcriptDelta: string = String(body.transcriptDelta || '').trim();
    const seen: string[] = Array.isArray(body.seen) ? body.seen.slice(0, 40).map((s: any) => String(s)) : [];
    const active: Array<{ id: string; description?: string; unit?: string }> =
      Array.isArray(body.active) ? body.active.slice(0, 20) : [];
    const frameB64: string = typeof body.frame === 'string' ? body.frame : '';
    if (!frameB64) return res.status(400).json({ error: 'No frame.' });

    let imageBlock: any;
    try {
      const buf = Buffer.from(frameB64, 'base64');
      const jpeg = await sharp(buf).rotate().resize(FRAME_EDGE, FRAME_EDGE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 55 }).toBuffer();
      imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
    } catch {
      return res.status(400).json({ error: 'Bad frame.' });
    }

    const catalog = await getCachedCatalog();
    if (catalog.length === 0) return res.status(500).json({ error: 'Catalog not loaded.' });

    // Resolve a free-text work phrase → real catalog item + computed fields.
    // Applies the confidence floor and the blinds→faux-wood guard.
    const resolveItem = async (query: string, categoryHint: string) => {
      const q = String(query || '').trim();
      if (!q) return null;
      const match = await matchCatalog(q, catalog, { sectionName, categoryHint });
      let top = match.candidates[0];
      if (!top || !match.confident) return null;
      if (/\bblind/i.test(q) && !/valance|wand|vertical/i.test(q) && /valance|wand/i.test(top.item.laborShortDescription)) {
        const faux = match.candidates.find((c) => /faux\s*wood\s*blind/i.test(c.item.laborShortDescription));
        if (faux) top = faux;
      }
      const item = top.item;
      const unit = (item.laborMeas || '').trim().toUpperCase();
      const isMeasured = unit === 'SF' || unit === 'LF' || unit === 'SY';
      const isWholeHouse = /\b(whole|full)\s*house\b/i.test(item.laborShortDescription || '');
      const depKind = depKindForCategory(item.category, item.laborShortDescription);
      const tenantPct = depKind ? depreciationTenantPct(depKind, tenantMonths) : 100;
      const measurementUnit = isMeasured && !isWholeHouse ? (unit === 'SF' ? 'square feet' : unit === 'LF' ? 'linear feet' : 'square yards') : '';
      return { item, unit, isMeasured, isWholeHouse, tenantPct, measurementUnit };
    };

    const userContent: any[] = [
      { type: 'text', text:
        `Room: ${sectionName}. Current frame below.` +
        (transcriptDelta ? `\nInspector just said: "${transcriptDelta}"` : '') +
        (seen.length ? `\nAlready suggested (do NOT repeat): ${seen.join('; ')}` : '') +
        (active.length ? `\nPending items the inspector may amend (use edit_line with the id):\n` + active.map((a) => `  [${a.id}] ${a.description}${a.unit ? ` (${a.unit})` : ''}`).join('\n') : '') +
        `\nReturn NEW items via suggest_line and/or amendments via edit_line (often none).`
      },
      imageBlock,
    ];

    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL_FAST,
        max_tokens: 900,
        system: SYSTEM,
        tools: [SUGGEST_TOOL, EDIT_TOOL],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Live vision failed ${resp.status}: ${t.slice(0, 160)}`);
    }
    const data = await resp.json();
    const content: any[] = data.content || [];
    const suggestUses = content.filter((c: any) => c.type === 'tool_use' && c.name === 'suggest_line');
    const editUses = content.filter((c: any) => c.type === 'tool_use' && c.name === 'edit_line');

    // --- new suggestions ---
    const seenLower = new Set(seen.map((s) => s.toLowerCase()));
    const out: any[] = [];
    for (let i = 0; i < suggestUses.length; i++) {
      const inp = suggestUses[i].input || {};
      const resolved = await resolveItem(String(inp.query || ''), String(inp.category || ''));
      if (!resolved) continue;
      const { item, unit, isMeasured, isWholeHouse, tenantPct, measurementUnit } = resolved;
      if (seenLower.has(item.lineItemCode.toLowerCase()) || seenLower.has(item.laborShortDescription.toLowerCase())) continue;
      seenLower.add(item.lineItemCode.toLowerCase());
      const quantityStated = inp.quantityStated === true && typeof inp.quantity === 'number' && isFinite(inp.quantity);
      const needsMeasurement = isMeasured && !isWholeHouse && !quantityStated;
      const quantity = quantityStated ? Number(inp.quantity) : (needsMeasurement ? null : 1);
      const rawEst = Number(inp.estimatedQuantity);
      const estimatedQuantity = (needsMeasurement && isFinite(rawEst) && rawEst > 0) ? Math.min(100000, Math.round(rawEst)) : null;
      out.push({
        id: `LIVE-${Date.now()}-${i}`,
        description: item.laborShortDescription,
        lineItemCode: item.lineItemCode,
        category: item.category,
        subcategory: item.subcategory,
        unit,
        quantity,
        needsMeasurement,
        measurementUnit,
        estimatedQuantity,
        suggestedVendor: 'Vendor 1',
        tenantBillBackPercent: tenantPct,
        rationale: String(inp.rationale || '').slice(0, 160),
        confidence: (inp.confidence === 'high' || inp.confidence === 'low') ? inp.confidence : 'medium',
      });
    }

    // --- voice edits to pending items ---
    const edits: any[] = [];
    const activeIds = new Set(active.map((a) => String(a.id)));
    for (const eu of editUses) {
      const inp = eu.input || {};
      const targetId = String(inp.targetId || '');
      if (!activeIds.has(targetId)) continue;
      const edit: any = { targetId };
      if (typeof inp.quantity === 'number' && isFinite(inp.quantity) && inp.quantity > 0) edit.quantity = inp.quantity;
      if (typeof inp.tenantPct === 'number' && isFinite(inp.tenantPct)) edit.tenantBillBackPercent = Math.max(0, Math.min(100, Math.round(inp.tenantPct)));
      if (typeof inp.vendor === 'string' && inp.vendor.trim()) {
        const vq = inp.vendor.trim().toLowerCase();
        const v = VENDORS.find((x) => x.toLowerCase() === vq) || VENDORS.find((x) => x.toLowerCase().includes(vq));
        if (v) edit.vendor = v;
      }
      if (typeof inp.scopeQuery === 'string' && inp.scopeQuery.trim()) {
        const r = await resolveItem(inp.scopeQuery, '');
        if (r) {
          edit.lineItemCode = r.item.lineItemCode;
          edit.description = r.item.laborShortDescription;
          edit.category = r.item.category;
          edit.subcategory = r.item.subcategory;
          edit.unit = r.unit;
          edit.needsMeasurement = r.isMeasured && !r.isWholeHouse;
          edit.measurementUnit = r.measurementUnit;
          edit.tenantBillBackPercent = edit.tenantBillBackPercent ?? r.tenantPct;
        }
      }
      if (Object.keys(edit).length > 1) edits.push(edit);
    }

    return res.status(200).json({ suggestions: out, edits });
  } catch (e: any) {
    console.error('[room-scan-live] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
