// Room Scan (Beta) — Phase 1 of the camera-AI scope assistant.
//
// The client records a short room video, extracts a handful of still frames,
// and (optionally) transcribes the inspector's voice-over. It POSTs the frames
// + transcript here. We send the frames to Claude vision with a structured
// tool and turn what it sees — plus anything the inspector called out — into
// DRAFT rate-card line-item suggestions. Each suggestion is resolved to a real
// catalog code via the same embedding matcher the voice assistant uses, and
// flags whether a measured quantity (SF/LF/SY) still needs the inspector to
// confirm it.
//
// Nothing is saved here. The client shows the suggestions in a review modal
// (add / decline each, fill in any unknown measurement) exactly like AI review,
// and only then writes the chosen lines via the normal rate-card-lines path.
//
// Mirrors the proven pattern in ai-review.ts (Claude vision + tool) and
// voice-assist.ts (catalog matching + measured-unit guardrails).

import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import { getSessionFromRequest } from '@/lib/auth';
import { matchCatalog } from '@/lib/voiceCatalogMatch';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { depKindForCategory, depreciationTenantPct } from '@/lib/depreciation';

export const config = {
  // Vision over several frames takes a while; allow headroom. Frames arrive as
  // base64 so the body is a few MB.
  maxDuration: 120,
  api: { bodyParser: { sizeLimit: '12mb' } },
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const FRAME_EDGE = 768;      // px — downscale frames for token economy
const MAX_FRAMES = 12;

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY is not set — Room Scan is unavailable.');
  return k;
}

const SYSTEM = [
  'You are a senior move-out scope reviewer looking at still frames captured from a short video walk-through of ONE room, plus an optional voice-over transcript from the inspector.',
  'Your job: propose the move-out repair/turn line items the room needs, to the investment-property standard of SAFE, CLEAN, FUNCTIONAL — no luxury upgrades.',
  'For EACH distinct item you can justify from the frames or the voice-over, call the suggest_line tool ONCE. Emit all of them in this single response. Do not write prose.',
  'Be conservative: only suggest work you can actually see evidence for (damage, missing items, heavy soiling, obvious wear) or that the inspector explicitly called out in the voice-over. If you are unsure, lower the confidence rather than inventing work.',
  'MEASURED items (carpet/flooring in SF, trim/gutters/baseboard in LF): set quantityStated=true and the number ONLY if the inspector actually said a measurement in the voice-over. Otherwise leave quantity empty and quantityStated=false — the inspector will confirm the measurement. NEVER guess square footage or linear feet from a frame.',
  'COUNT/EACH items (fixtures, outlets, blinds, a single patch): quantity defaults to 1 — set quantity=1, quantityStated=true.',
  'For each suggestion set frameIndex to the 0-based index of the frame that best shows the issue, so we can attach that still to the line.',
  'The `query` field is a short catalog search phrase for the work (e.g. "replace carpet", "4x4 drywall patch", "sales clean", "blind replacement") — we resolve it to an exact catalog code on our side, so you do not need a code.',
].join('\n');

const SUGGEST_TOOL = {
  name: 'suggest_line',
  description: 'Propose ONE draft line item for the room. Call once per distinct item; emit all in a single response.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Short catalog search phrase for the work, e.g. "replace carpet", "4x4 drywall patch", "level 1 sales clean".' },
      category: { type: 'string', description: 'Best-guess catalog category, e.g. Flooring, Painting, Cleaning, Drywall, Electrical, Plumbing, Appliance, Doors, Windows/Glass.' },
      quantity: { type: 'number', description: 'Quantity if (and only if) it is known: 1 for count/EA items, or the measured amount IF the inspector stated it in the voice-over. Omit for measured items with no stated measurement.' },
      quantityStated: { type: 'boolean', description: 'true only when quantity is genuinely known (count item = 1, or the inspector said the measurement). false for measured items needing the inspector to confirm.' },
      frameIndex: { type: 'integer', description: '0-based index of the frame that best shows this issue.' },
      rationale: { type: 'string', description: 'One short sentence on what you see that justifies this line.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How sure you are this work is warranted.' },
    },
    required: ['query', 'rationale'],
  },
};

interface FrameIn { data: string; mime?: string }

interface Suggestion {
  id: string;
  query: string;
  description: string;       // catalog short description (display)
  lineItemCode: string;
  category: string;
  subcategory: string;
  unit: string;             // EA / SF / LF / SY ...
  quantity: number | null;  // null => needs the inspector to enter a measurement
  needsMeasurement: boolean;
  measurementUnit: string;  // 'square feet' | 'linear feet' | '' (for needsMeasurement)
  suggestedVendor: string;
  tenantBillBackPercent: number;
  frameIndex: number;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  matchScore: number;
}

async function frameToImageBlock(f: FrameIn): Promise<any | null> {
  try {
    const buf = Buffer.from(f.data, 'base64');
    if (buf.length === 0) return null;
    const jpeg = await sharp(buf).rotate()
      .resize(FRAME_EDGE, FRAME_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 60 }).toBuffer();
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
  } catch {
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const body = req.body || {};
    const sectionName: string = String(body.sectionName || 'this room');
    const region: string = String(body.region || '');
    const transcript: string = String(body.transcript || '').trim();
    const tenantMonths: number = (typeof body.tenantMonths === 'number' && body.tenantMonths > 0) ? body.tenantMonths : 12;
    const framesIn: FrameIn[] = Array.isArray(body.frames) ? body.frames.slice(0, MAX_FRAMES) : [];

    if (framesIn.length === 0) {
      return res.status(400).json({ error: 'No frames provided.' });
    }

    // Build image blocks (drop any that fail to decode, keep index alignment).
    const imageBlocks: any[] = [];
    const frameMap: number[] = []; // imageBlock position -> original frame index
    for (let i = 0; i < framesIn.length; i++) {
      const block = await frameToImageBlock(framesIn[i]);
      if (block) {
        imageBlocks.push({ type: 'text', text: `Frame ${i}:` });
        imageBlocks.push(block);
        frameMap.push(i);
      }
    }
    if (imageBlocks.length === 0) return res.status(400).json({ error: 'Could not read any frames.' });

    const catalog = await getCachedCatalog();
    if (catalog.length === 0) return res.status(500).json({ error: 'Catalog not loaded.' });

    const userContent: any[] = [
      { type: 'text', text:
        `Room: ${sectionName}.` +
        (transcript ? `\n\nInspector voice-over (use any measurements or specific call-outs from this): "${transcript}"` : '\n\n(No voice-over was provided.)') +
        `\n\nThe ${frameMap.length} frames below are stills from the room walk-through. Propose the needed line items via suggest_line — one call per distinct item, all in this response.`
      },
      ...imageBlocks,
    ];

    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        tools: [SUGGEST_TOOL],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Vision call failed ${resp.status}: ${t.slice(0, 200)}`);
    }
    const data = await resp.json();
    const toolUses: any[] = (data.content || []).filter((c: any) => c.type === 'tool_use' && c.name === 'suggest_line');

    // Resolve each suggestion to a real catalog code + unit, applying the same
    // measured-quantity guardrails as the voice assistant.
    const suggestions: Suggestion[] = [];
    for (let i = 0; i < toolUses.length; i++) {
      const inp = toolUses[i].input || {};
      const query = String(inp.query || '').trim();
      if (!query) continue;
      const match = await matchCatalog(query, catalog, { sectionName, categoryHint: String(inp.category || '') });
      const top = match.candidates[0];
      if (!top) continue; // no catalog match → drop (don't invent a code)
      const item = top.item;
      const unit = (item.laborMeas || '').trim().toUpperCase();
      const isMeasured = unit === 'SF' || unit === 'LF' || unit === 'SY';
      const isWholeHouse = /\b(whole|full)\s*house\b/i.test(item.laborShortDescription || '');
      const quantityStated = inp.quantityStated === true && typeof inp.quantity === 'number' && isFinite(inp.quantity);
      const needsMeasurement = isMeasured && !isWholeHouse && !quantityStated;
      const quantity = quantityStated ? Number(inp.quantity) : (needsMeasurement ? null : 1);

      // Default tenant % the same way voice/manual adds do (depreciation-aware).
      const depKind = depKindForCategory(item.category, item.laborShortDescription);
      const tenantPct = depKind ? depreciationTenantPct(depKind, tenantMonths) : 100;

      const frameIndex = (typeof inp.frameIndex === 'number' && frameMap.includes(Math.round(inp.frameIndex)))
        ? Math.round(inp.frameIndex)
        : (frameMap[0] ?? 0);

      suggestions.push({
        id: `SCAN-${Date.now()}-${i}`,
        query,
        description: item.laborShortDescription,
        lineItemCode: item.lineItemCode,
        category: item.category,
        subcategory: item.subcategory,
        unit,
        quantity,
        needsMeasurement,
        measurementUnit: needsMeasurement ? (unit === 'SF' ? 'square feet' : unit === 'LF' ? 'linear feet' : 'square yards') : '',
        suggestedVendor: 'Vendor 1',
        tenantBillBackPercent: tenantPct,
        frameIndex,
        rationale: String(inp.rationale || '').slice(0, 200),
        confidence: (inp.confidence === 'high' || inp.confidence === 'low') ? inp.confidence : 'medium',
        matchScore: Number(top.score.toFixed(3)),
      });
    }

    return res.status(200).json({ suggestions, region });
  } catch (e: any) {
    console.error('[room-scan] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
