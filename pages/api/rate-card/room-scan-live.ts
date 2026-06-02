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
  'You are a move-out scope reviewer watching a LIVE camera pan of one room. You get a single current frame plus any new voice-over from the inspector.',
  'STANDARD: SAFE, CLEAN, FUNCTIONAL — no luxury. QUALITY OVER QUANTITY: only call out work with clear visible evidence in THIS frame, or that the inspector just said. Most frames warrant ZERO new items — that is correct. Never invent work.',
  'You are given a list of items ALREADY suggested this session — do NOT repeat any of them or near-duplicates.',
  'Call suggest_line ONCE per genuinely-new item (often none). No prose.',
  'NO loose inferences (a cluttered vanity is not "clean the tub"). Match the line item to the actual issue.',
  'BLINDS default to a FAUX WOOD BLIND replacement — query "replace faux wood blind" (never valance/vertical/wand unless named).',
  'MEASURED items (SF/LF): set quantityStated=true + number ONLY if the inspector stated it; otherwise quantityStated=false and give estimatedQuantity — a rough size from the apparent room (a draft the inspector confirms). Never imply precision.',
  'COUNT/EA items: quantity=1, quantityStated=true.',
].join('\n');

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

    const userContent: any[] = [
      { type: 'text', text:
        `Room: ${sectionName}. Current frame below.` +
        (transcriptDelta ? `\nInspector just said: "${transcriptDelta}"` : '') +
        (seen.length ? `\nAlready suggested (do NOT repeat): ${seen.join('; ')}` : '') +
        `\nReturn only NEW items via suggest_line (often none).`
      },
      imageBlock,
    ];

    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL_FAST,
        max_tokens: 700,
        system: SYSTEM,
        tools: [SUGGEST_TOOL],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Live vision failed ${resp.status}: ${t.slice(0, 160)}`);
    }
    const data = await resp.json();
    const toolUses: any[] = (data.content || []).filter((c: any) => c.type === 'tool_use' && c.name === 'suggest_line');

    const seenLower = new Set(seen.map((s) => s.toLowerCase()));
    const out: any[] = [];
    for (let i = 0; i < toolUses.length; i++) {
      const inp = toolUses[i].input || {};
      const query = String(inp.query || '').trim();
      if (!query) continue;
      const match = await matchCatalog(query, catalog, { sectionName, categoryHint: String(inp.category || '') });
      const top = match.candidates[0];
      if (!top || !match.confident) continue;
      const item = top.item;
      // Dedupe against what's already on screen (by code or description).
      if (seenLower.has(item.lineItemCode.toLowerCase()) || seenLower.has(item.laborShortDescription.toLowerCase())) continue;
      seenLower.add(item.lineItemCode.toLowerCase());

      const unit = (item.laborMeas || '').trim().toUpperCase();
      const isMeasured = unit === 'SF' || unit === 'LF' || unit === 'SY';
      const isWholeHouse = /\b(whole|full)\s*house\b/i.test(item.laborShortDescription || '');
      const quantityStated = inp.quantityStated === true && typeof inp.quantity === 'number' && isFinite(inp.quantity);
      const needsMeasurement = isMeasured && !isWholeHouse && !quantityStated;
      const quantity = quantityStated ? Number(inp.quantity) : (needsMeasurement ? null : 1);
      const rawEst = Number(inp.estimatedQuantity);
      const estimatedQuantity = (needsMeasurement && isFinite(rawEst) && rawEst > 0) ? Math.min(100000, Math.round(rawEst)) : null;
      const depKind = depKindForCategory(item.category, item.laborShortDescription);
      const tenantPct = depKind ? depreciationTenantPct(depKind, tenantMonths) : 100;

      out.push({
        id: `LIVE-${Date.now()}-${i}`,
        description: item.laborShortDescription,
        lineItemCode: item.lineItemCode,
        category: item.category,
        subcategory: item.subcategory,
        unit,
        quantity,
        needsMeasurement,
        measurementUnit: needsMeasurement ? (unit === 'SF' ? 'square feet' : unit === 'LF' ? 'linear feet' : 'square yards') : '',
        estimatedQuantity,
        suggestedVendor: 'Vendor 1',
        tenantBillBackPercent: tenantPct,
        rationale: String(inp.rationale || '').slice(0, 160),
        confidence: (inp.confidence === 'high' || inp.confidence === 'low') ? inp.confidence : 'medium',
      });
    }

    return res.status(200).json({ suggestions: out });
  } catch (e: any) {
    console.error('[room-scan-live] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
