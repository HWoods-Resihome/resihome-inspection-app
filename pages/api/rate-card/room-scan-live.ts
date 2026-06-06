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
import { getKnowledgeBasePromptText } from '@/lib/hubspot';
import { matchCatalog } from '@/lib/voiceCatalogMatch';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { depKindForCategory, depreciationTenantPct } from '@/lib/depreciation';
import { VENDORS } from '@/lib/vendors';
import { recordAiUsage } from '@/lib/aiUsage';

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
  'You help a property inspector capture move-out repair scope. You get the current camera frame, any new VOICE-OVER from the inspector, the items ALREADY suggested this session, and the items still PENDING their decision.',
  'STANDARD: SAFE, CLEAN, FUNCTIONAL — no luxury.',
  'VOICE IS THE PRIMARY SIGNAL — OBEY IT LITERALLY. The inspector is telling you what work is needed. For EVERY concrete task or defect they mention, you MUST call suggest_line — once per item. This is REQUIRED, not optional. Do this EVEN IF the item is not visible in the frame, EVEN IF the frame shows something completely unrelated (e.g. a car, a road, a hallway), and EVEN IF you are unsure of the exact catalog item. NEVER stay silent on something they explicitly named. Examples that MUST each produce a suggest_line: "I need to trim the bushes" -> query "trim bushes / shrub trimming"; "the carpet is stained" -> "replace carpet"; "replace this blind" -> "replace faux wood blind"; "paint the whole room" -> "paint whole room"; "the outlet cover is missing" -> "replace outlet cover"; "clean the oven" -> "clean oven"; "light bulb is out" -> "replace light bulb". If they list several things, emit several suggest_line calls.',
  'Translate their words into the closest catalog work phrase in the query field. When unsure, STILL call suggest_line with your best guess query rather than skipping it — a wrong-but-close suggestion they can dismiss is far better than silence.',
  'VISION IS SECONDARY AND CONSERVATIVE: from the frame ALONE (when the inspector said nothing relevant), only call out work with clear, unambiguous visible damage. Most frames warrant ZERO purely-visual items — that is fine. Never invent visual work.',
  'Do NOT repeat anything in the already-suggested list (or near-duplicates).',
  'TWO things you can do, both via tools, all in one response (often neither):',
  ' • suggest_line — a genuinely NEW item seen or just called out.',
  ' • edit_line — the inspector is amending a PENDING item by voice. Use the pending list + transcript. Examples: "make it two walls" -> quantity 2 on the wall-paint item; "whole room" / "paint the whole room" -> scopeQuery "whole room paint" on that item; "assign that to PPW" -> vendor "PPW"; "fifty percent tenant" -> tenantPct 50. Set targetId to the pending item being amended.',
  'NO loose inferences (a cluttered vanity is not "clean the tub"). Match the line item to the actual issue.',
  'BLINDS: a broken/missing/damaged blind is ALWAYS a FAUX WOOD BLIND replacement — query EXACTLY "replace faux wood blind". NEVER a valance, vertical blind, or wand unless the inspector names that exact part.',
  'MEASURED items (SF/LF): set quantityStated=true + number ONLY if the inspector stated it; otherwise quantityStated=false and give estimatedQuantity — a rough size from the apparent room (a draft the inspector confirms). Never imply precision.',
  'COUNT/EA items: quantity=1, quantityStated=true.',
  'OUTPUT FORMAT: respond with tool calls ONLY. Never write any prose, preamble, or explanation text — every word slows the inspector down. If there is nothing to add or amend, return no tool calls and no text.',
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
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  // Warm-up ping (GET): pre-load the cold-start work — catalog + its embeddings
  // + the Voyage query path — and prime Haiku (TLS + server-side prompt cache),
  // so the inspector's FIRST spoken call-out in the AI camera is fast. The client
  // fires this when the camera opens. No vision call, so it's cheap.
  if (req.method === 'GET') {
    try {
      const [catalog, kb] = await Promise.all([
        getCachedCatalog(),
        getKnowledgeBasePromptText().catch(() => ''),
      ]);
      const warmSystem = kb
        ? `${SYSTEM}\n\nOPERATOR KNOWLEDGE BASE — house rules from inspectors. Treat these as authoritative guidance; apply them when relevant to your call-outs and edits:\n${kb}`
        : SYSTEM;
      await Promise.allSettled([
        matchCatalog('warmup', catalog, { topK: 1 }),
        (async () => {
          try {
            // Prime the EXACT cache prefix the real POST uses (same tools + same
            // cached system block) so the inspector's first call-out is a cache HIT.
            await fetch(ANTHROPIC_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: MODEL_FAST, max_tokens: 1, system: [{ type: 'text', text: warmSystem, cache_control: { type: 'ephemeral' } }], tools: [SUGGEST_TOOL, EDIT_TOOL], messages: [{ role: 'user', content: 'ok' }] }),
            });
          } catch { /* non-fatal */ }
        })(),
      ]);
    } catch { /* non-fatal warm-up */ }
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const sectionName: string = String(body.sectionName || 'this room');
    const tenantMonths: number = (typeof body.tenantMonths === 'number' && body.tenantMonths > 0) ? body.tenantMonths : 12;
    const transcriptDelta: string = String(body.transcriptDelta || '').trim();
    const seen: string[] = Array.isArray(body.seen) ? body.seen.slice(0, 40).map((s: any) => String(s)) : [];
    // Codes already on screen — the authoritative dedup key (descriptions are
    // only for telling the model what NOT to repeat).
    const seenCodes: string[] = Array.isArray(body.seenCodes) ? body.seenCodes.slice(0, 60).map((s: any) => String(s).toLowerCase()) : [];
    const active: Array<{ id: string; description?: string; unit?: string }> =
      Array.isArray(body.active) ? body.active.slice(0, 20) : [];
    const frameB64: string = typeof body.frame === 'string' ? body.frame : '';
    // VOICE ticks run TEXT-ONLY — the frame is ignored by the model — so we must
    // NOT spend time decoding/re-encoding it on the hot call-out path. The image
    // is only needed (and only processed) on SILENT vision ticks.
    const hasVoice = !!transcriptDelta;
    if (!frameB64 && !hasVoice) return res.status(400).json({ error: 'No frame.' });
    const needImage = !!frameB64 && !hasVoice;

    // Fire the cold-start work concurrently instead of serially: catalog (cached),
    // the operator knowledge base (cached ~60s), and — only when needed — the
    // Sharp frame re-encode. None of these block one another any more.
    const [catalog, kb, imageBlock] = await Promise.all([
      getCachedCatalog(),
      getKnowledgeBasePromptText().catch(() => ''),
      (async (): Promise<any> => {
        if (!needImage) return undefined;
        try {
          const buf = Buffer.from(frameB64, 'base64');
          const jpeg = await sharp(buf).rotate().resize(FRAME_EDGE, FRAME_EDGE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 55 }).toBuffer();
          return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
        } catch { return undefined; }
      })(),
    ]);
    if (catalog.length === 0) return res.status(500).json({ error: 'Catalog not loaded.' });
    // A silent tick whose only frame failed to decode has nothing to analyze.
    if (!hasVoice && !imageBlock) return res.status(400).json({ error: 'Bad frame.' });

    // Resolve a free-text work phrase → real catalog item + computed fields.
    // Applies the confidence floor and the blinds→faux-wood guard.
    // Voice-named items get a more lenient match floor: the inspector explicitly
    // asked for the work, so a close-but-sub-threshold candidate beats dropping it.
    const VOICE_FLOOR = 0.32;
    const resolveItem = async (query: string, categoryHint: string, fromVoice = false) => {
      const q = String(query || '').trim();
      if (!q) return null;
      const match = await matchCatalog(q, catalog, { sectionName, categoryHint });
      let top = match.candidates[0];
      const ok = match.confident || (fromVoice && top && match.topScore >= VOICE_FLOOR);
      if (!top || !ok) return null;
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

    // When the inspector SPOKE, we run a TEXT-ONLY pass (no frame). An image
    // model fed an unrelated frame (a road, a hallway) keeps discounting the
    // voice; text-only Haiku obeys the instruction reliably and is faster. The
    // frame is only used on silent ticks for conservative visual call-outs.
    const sharedTail =
      (seen.length ? `\nAlready suggested (do NOT repeat): ${seen.join('; ')}` : '') +
      (active.length ? `\nPending items the inspector may amend (use edit_line with the id):\n` + active.map((a) => `  [${a.id}] ${a.description}${a.unit ? ` (${a.unit})` : ''}`).join('\n') : '');

    const userContent: any[] = hasVoice
      ? [{ type: 'text', text:
          `Room: ${sectionName}.\n` +
          `*** THE INSPECTOR JUST SAID: "${transcriptDelta}" ***\n` +
          `This is a direct work order. Call suggest_line for EACH distinct repair/replace/clean/paint/trim/install/remove task or defect in that sentence — one call per item. This is REQUIRED. Do NOT ask for confirmation, do NOT skip items, do NOT stay silent. If a phrase is a defect ("X is broken/missing/stained/dirty/out") emit the corresponding repair. If you are unsure of the exact catalog item, still call suggest_line with your best query.` +
          sharedTail +
          `\nUse edit_line instead of suggest_line only when they are clearly amending a PENDING item above.`
        }]
      : [{ type: 'text', text:
          `Room: ${sectionName}. Current frame below. No new voice this tick — only call suggest_line for clear, unambiguous VISIBLE damage in the frame (usually none; staying silent is correct).` +
          sharedTail
        }, imageBlock];

    // Operator knowledge base — field-trained tips inspectors taught the AI by
    // voice (admin-curated). Appended to the system prompt so call-outs/edits
    // learn from feedback. Fetched in parallel above (cached ~60s).
    //
    // The whole system text is sent as ONE cached block (cache_control:ephemeral)
    // so Anthropic processes the prompt prefix (tools + system) from cache — the
    // warm-up GET primes the identical prefix. This mirrors the voice path and is
    // the single biggest TTFT win once the prefix is large enough to cache.
    const systemText = kb
      ? `${SYSTEM}\n\nOPERATOR KNOWLEDGE BASE — house rules from inspectors. Treat these as authoritative guidance; apply them when relevant to your call-outs and edits:\n${kb}`
      : SYSTEM;

    // Dedup by CODE only (the client also filters by code). A new item that
    // merely shares wording with a prior one must still surface, so descriptions
    // are NOT used to drop items. activeIds gate which pending items may be edited.
    const seenCodeSet = new Set(seenCodes);
    const activeIds = new Set(active.map((a) => String(a.id)));
    let outIdx = 0;

    // Shape a resolved catalog item into the client suggestion the chip binds to.
    const buildSuggestionObj = (inp: any, resolved: any) => {
      const { item, unit, isMeasured, isWholeHouse, tenantPct, measurementUnit } = resolved;
      const quantityStated = inp.quantityStated === true && typeof inp.quantity === 'number' && isFinite(inp.quantity);
      const needsMeasurement = isMeasured && !isWholeHouse && !quantityStated;
      const quantity = quantityStated ? Number(inp.quantity) : (needsMeasurement ? null : 1);
      const rawEst = Number(inp.estimatedQuantity);
      const estimatedQuantity = (needsMeasurement && isFinite(rawEst) && rawEst > 0) ? Math.min(100000, Math.round(rawEst)) : null;
      return {
        id: `LIVE-${Date.now()}-${outIdx++}`,
        description: item.laborShortDescription,
        lineItemCode: item.lineItemCode,
        category: item.category,
        subcategory: item.subcategory,
        unit, quantity, needsMeasurement, measurementUnit, estimatedQuantity,
        suggestedVendor: 'Vendor 1',
        tenantBillBackPercent: tenantPct,
        rationale: String(inp.rationale || '').slice(0, 160),
        confidence: (inp.confidence === 'high' || inp.confidence === 'low') ? inp.confidence : 'medium',
      };
    };

    // Shape an edit_line tool call (+ optionally a re-resolved scope item) into a
    // client edit patch, or null if it amends nothing / targets an unknown item.
    const buildEditObj = (inp: any, scopeResolved: any) => {
      const targetId = String(inp.targetId || '');
      if (!activeIds.has(targetId)) return null;
      const edit: any = { targetId };
      if (typeof inp.quantity === 'number' && isFinite(inp.quantity) && inp.quantity > 0) edit.quantity = inp.quantity;
      if (typeof inp.tenantPct === 'number' && isFinite(inp.tenantPct)) edit.tenantBillBackPercent = Math.max(0, Math.min(100, Math.round(inp.tenantPct)));
      if (typeof inp.vendor === 'string' && inp.vendor.trim()) {
        const vq = inp.vendor.trim().toLowerCase();
        const v = VENDORS.find((x) => x.toLowerCase() === vq) || VENDORS.find((x) => x.toLowerCase().includes(vq));
        if (v) edit.vendor = v;
      }
      if (typeof inp.scopeQuery === 'string' && inp.scopeQuery.trim() && scopeResolved) {
        const r = scopeResolved;
        edit.lineItemCode = r.item.lineItemCode;
        edit.description = r.item.laborShortDescription;
        edit.category = r.item.category;
        edit.subcategory = r.item.subcategory;
        edit.unit = r.unit;
        edit.needsMeasurement = r.isMeasured && !r.isWholeHouse;
        edit.measurementUnit = r.measurementUnit;
        edit.tenantBillBackPercent = edit.tenantBillBackPercent ?? r.tenantPct;
      }
      return Object.keys(edit).length > 1 ? edit : null;
    };

    const wantStream = body.stream === true || body.stream === 'true';

    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL_FAST,
        max_tokens: 900,
        system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
        tools: [SUGGEST_TOOL, EDIT_TOOL],
        // Always 'auto': forcing a tool call would turn navigation commands
        // ("move to front entryway") and noise into bogus suggestions. The
        // text-only voice pass + strong prompt is enough for real work items.
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: userContent }],
        ...(wantStream ? { stream: true } : {}),
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Live vision failed ${resp.status}: ${t.slice(0, 160)}`);
    }

    // ---------------- STREAMING PATH (SSE) ----------------
    // Mirror the voice path: stream the model and emit each call-out the INSTANT
    // its tool block completes + resolves against the catalog — so chips pop in
    // one-by-one as the inspector talks instead of all at once after the full
    // response. Catalog resolves run concurrently and overlap generation.
    if (wantStream && resp.body) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      (res as any).flushHeaders?.();
      const send = (event: string, data: any) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
      };

      let usageIn = 0, usageOut = 0;
      const pending: Promise<void>[] = [];
      const blocks: Record<number, { name: string; json: string }> = {};

      // A tool block just completed — resolve + emit it without waiting on the rest.
      const handleBlock = (b: { name: string; json: string }) => {
        let inp: any = {};
        try { inp = b.json ? JSON.parse(b.json) : {}; } catch { inp = {}; }
        if (b.name === 'suggest_line') {
          pending.push(
            resolveItem(String(inp.query || ''), String(inp.category || ''), hasVoice).then((resolved) => {
              if (!resolved) { if (inp.query) send('unmatched', { query: String(inp.query).slice(0, 40) }); return; }
              const code = resolved.item.lineItemCode.toLowerCase();
              if (seenCodeSet.has(code)) return;           // microtask-atomic: no race
              seenCodeSet.add(code);
              send('suggestion', buildSuggestionObj(inp, resolved));
            }).catch(() => {}),
          );
        } else if (b.name === 'edit_line') {
          const sq = inp.scopeQuery;
          const sp = (typeof sq === 'string' && sq.trim()) ? resolveItem(sq, '') : Promise.resolve(null);
          pending.push(sp.then((sr) => { const e = buildEditObj(inp, sr); if (e) send('edit', e); }).catch(() => {}));
        }
      };

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
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
              if (ev.content_block?.type === 'tool_use') blocks[ev.index] = { name: ev.content_block.name, json: '' };
            } else if (ev.type === 'content_block_delta') {
              if (ev.delta?.type === 'input_json_delta' && blocks[ev.index]) blocks[ev.index].json += ev.delta.partial_json || '';
            } else if (ev.type === 'content_block_stop') {
              if (blocks[ev.index]) { handleBlock(blocks[ev.index]); delete blocks[ev.index]; }
            } else if (ev.type === 'message_delta') {
              if (ev.usage?.output_tokens) usageOut = ev.usage.output_tokens;
            }
          }
        }
      } catch { send('error', { error: 'stream interrupted' }); }
      // Let any in-flight catalog resolutions finish emitting before we close.
      await Promise.allSettled(pending);
      recordAiUsage({ source: 'room_scan_live', model: MODEL_FAST, inputTokens: usageIn, outputTokens: usageOut });
      send('done', {});
      res.end();
      return;
    }

    // ---------------- NON-STREAMING JSON PATH (fallback) ----------------
    const data = await resp.json();
    recordAiUsage({ source: 'room_scan_live', model: MODEL_FAST, inputTokens: data?.usage?.input_tokens, outputTokens: data?.usage?.output_tokens });
    const content: any[] = data.content || [];
    const suggestUses = content.filter((c: any) => c.type === 'tool_use' && c.name === 'suggest_line');
    const editUses = content.filter((c: any) => c.type === 'tool_use' && c.name === 'edit_line');

    const out: any[] = [];
    const unmatched: string[] = [];
    // Resolve every suggested phrase against the catalog CONCURRENTLY.
    const suggestResolved = await Promise.all(
      suggestUses.map((u: any) => resolveItem(String(u.input?.query || ''), String(u.input?.category || ''), hasVoice)),
    );
    for (let i = 0; i < suggestUses.length; i++) {
      const inp = suggestUses[i].input || {};
      const resolved = suggestResolved[i];
      if (!resolved) { if (inp.query) unmatched.push(String(inp.query).slice(0, 40)); continue; }
      const code = resolved.item.lineItemCode.toLowerCase();
      if (seenCodeSet.has(code)) continue;
      seenCodeSet.add(code);
      out.push(buildSuggestionObj(inp, resolved));
    }

    const edits: any[] = [];
    const editScopeResolved = await Promise.all(
      editUses.map((eu: any) => {
        const sq = eu.input?.scopeQuery;
        return (typeof sq === 'string' && sq.trim()) ? resolveItem(sq, '') : Promise.resolve(null);
      }),
    );
    for (let ei = 0; ei < editUses.length; ei++) {
      const e = buildEditObj(editUses[ei].input || {}, editScopeResolved[ei]);
      if (e) edits.push(e);
    }

    return res.status(200).json({ suggestions: out, edits, unmatched });
  } catch (e: any) {
    console.error('[room-scan-live] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
