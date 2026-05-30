// pages/api/rate-card/voice-assist.ts
//
// Conversational line-item assistant for the Scope rate card (online-only).
//
// FLOW (one POST per assistant turn — the client keeps the running transcript):
//   client sends { messages, section, location, region } where `messages` is the
//   running [{role, content}] transcript (inspector speech as 'user' turns).
//   This route runs Claude with tools, resolves any tool calls server-side
//   (semantic catalog search via Voyage embeddings; catalog detail lookups),
//   and returns ONE of:
//     { type: 'question', text }            -> assistant needs more info; show + ask
//     { type: 'proposal', line, summary }   -> a complete RateCardLineInput to confirm
//     { type: 'message', text }             -> plain reply (e.g. "couldn't match that")
//
// COST: Claude only ever sees the top-K candidate lines (not all 853), and the
// catalog embeddings are built once per version (see lib/voiceCatalogMatch.ts).
//
// The route NEVER saves anything. The client shows the proposal as a draft row;
// on confirm it POSTs the line to the existing /api/inspections/[id]/rate-card-lines
// endpoint, which is the single authoritative path for math + upsert.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchRateCardCatalog } from '@/lib/hubspot';
import { matchCatalog, getCatalogEmbeddings } from '@/lib/voiceCatalogMatch';
import { calculateLine } from '@/lib/rateCardMath';
import { getCachedRegions } from '@/pages/api/rate-card/regions';
import { VENDORS } from '@/lib/vendors';
import type { RateCardLineItem, RateCardLineInput, RegionRate } from '@/lib/types';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// Two-model split: the smart model is used when the agent must reason about
// catalog matching (a turn that calls search_catalog); the fast model handles
// simple clarify turns (e.g. "how many linear feet?"). This keeps the common,
// chatty turns snappy without sacrificing match quality.
const MODEL_SMART = 'claude-opus-4-8';
const MODEL_FAST = 'claude-haiku-4-5-20251001';
const MAX_TOOL_ROUNDS = 8; // safety cap on tool loops per turn (compound requests: switch + multiple items)

interface ClientMessage { role: 'user' | 'assistant'; content: string; }
interface CurrentLine {
  externalId: string;
  lineItemCode: string;
  quantity: number;
  assignedTo: string;
  tenantBillBackPercent: number;
}
interface BodyShape {
  messages: ClientMessage[];
  section: string;
  location: string;
  region: string;
  currentLines?: CurrentLine[];
  rooms?: { id: string; name: string }[];
  currentRoom?: string;
}

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY is not set — voice assistant is unavailable.');
  return k;
}

// Call Anthropic with streaming on. Forward any assistant TEXT deltas to the
// client over SSE as they arrive (this is what makes clarify turns feel
// instant), while assembling the full content-block array (text + tool_use) so
// the tool loop can run normally once the turn completes.
// `onTextDelta` is called with each text chunk; returns { content, stopReason }.
async function streamAnthropic(
  payload: any,
  onTextDelta: (chunk: string) => void
): Promise<{ content: any[]; stopReason: string | null }> {
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Assistant call failed ${resp.status}: ${t.slice(0, 200)}`);
  }

  // Assemble content blocks from the SSE event stream.
  const blocks: any[] = [];
  let stopReason: string | null = null;
  const toolJsonByIndex: Record<number, string> = {};

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

      if (ev.type === 'content_block_start') {
        const cb = ev.content_block;
        if (cb?.type === 'text') blocks[ev.index] = { type: 'text', text: '' };
        else if (cb?.type === 'tool_use') {
          blocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
          toolJsonByIndex[ev.index] = '';
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta') {
          if (blocks[ev.index]) blocks[ev.index].text += d.text;
          onTextDelta(d.text);
        } else if (d?.type === 'input_json_delta') {
          toolJsonByIndex[ev.index] = (toolJsonByIndex[ev.index] || '') + (d.partial_json || '');
        }
      } else if (ev.type === 'content_block_stop') {
        if (toolJsonByIndex[ev.index] != null && blocks[ev.index]?.type === 'tool_use') {
          try { blocks[ev.index].input = JSON.parse(toolJsonByIndex[ev.index] || '{}'); }
          catch { blocks[ev.index].input = {}; }
        }
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      }
    }
  }
  // Compact any holes left by index gaps.
  return { content: blocks.filter(Boolean), stopReason };
}

// SSE write helpers.
function sse(res: NextApiResponse, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function describeLines(catalogByCode: Map<string, RateCardLineItem>, lines: CurrentLine[]): string {
  if (!lines.length) return 'There are no line items in this area yet.';
  const rows = lines.map((l, i) => {
    const item = catalogByCode.get(l.lineItemCode);
    const desc = item ? item.laborShortDescription : l.lineItemCode;
    return `  ${i + 1}. id=${l.externalId} | ${desc} | qty ${l.quantity} | ${l.assignedTo} | ${l.tenantBillBackPercent}% tenant`;
  });
  return `Existing line items in this area:\n${rows.join('\n')}`;
}

function systemPrompt(
  section: string,
  location: string,
  linesDesc: string,
  currentRoom: string,
  rooms: { id: string; name: string }[] = []
): string {
  const loc = location || section;
  const roomName = currentRoom || loc;
  const lines = [
    `You are a property inspector's voice assistant for a home inspection. You help manage Scope rate-card line items hands-free as the inspector walks the home. Speed matters — keep them moving.`,
    ``,
    `You are currently working on the "${roomName}" room/area. Line items you add or edit go to THIS room.`,
  ];
  if (rooms.length > 1) {
    lines.push(
      ``,
      `ROOMS in this inspection: ${rooms.map((r) => r.name).join(', ')}.`,
      `The inspector can move you between rooms. When they say things like "close this out and go to Bedroom 2", "let's do the kitchen", "next room, primary bath", call switch_room with the matching room id. Resolve natural phrasing to the closest room name. After a successful switch, the app moves the form to that room and greets the inspector — you do NOT need to add anything. Only switch when they clearly ask to change rooms; if they're describing damage, that's a line item, not a room change.`
    );
  }
  lines.push(
    ``,
    `Defaults (apply silently unless the inspector says otherwise):`,
    `  - Vendor: "Vendor 1".  - Tenant chargeback: 100%.`,
    `Never ask about vendor or tenant percent. Only use a different value if the inspector states one (e.g. "assign to PPW", "50 percent tenant").`,
    ``,
    `ADDING a line:`,
    `1. Use search_catalog to find the line item matching what they described.`,
    `   - search_catalog returns a "confident" flag. If it's false, the catalog has no strong match — do NOT propose a guess. Briefly tell the inspector you're not sure that's in the catalog and ask them to rephrase or describe it differently.`,
    `2. Only ask a clarifying question if genuinely ambiguous (e.g. which of two distinct items). One short question, then proceed.`,
    `3. You need a quantity. If they stated it, use it; if not, ask once, naming the unit (e.g. "How many linear feet?"). EXCEPTION: in the "Whole House" room, items measured in SF (square feet) are auto-filled with the property's square footage — do NOT ask for a square-foot quantity there, just propose the line (quantity 1 is fine; the app replaces it with the property SF).`,
    `4. When you have a code and quantity AND the match is confident, call propose_line. The app adds the line automatically and announces it — you do NOT need the inspector to say yes first, and you must NOT claim you added it in your own words. If the match is not confident (see step 1), ask first instead of proposing.`,
    ``,
    `EDITING an existing line (e.g. "make that 50% tenant", "change the paint line to PPW", "that should be 3 not 1"):`,
    `  - Identify which existing line they mean (the most recent one if they say "that"/"the last one", or by description). Use the id from the list below.`,
    `  - Call edit_line with that externalId and only the fields to change. The app saves and announces it.`,
    ``,
    `${linesDesc}`,
    ``,
    `The inspector may ask for SEVERAL things in one breath — e.g. "I'm back in the kitchen, replace the black microwave" (switch room + add a line), "add a new water heater and replace the kitchen faucet" (two lines), or "the yard needs leaves raked and a gutter cleaning, 50 linear feet, two story" (TWO separate items: a leaf-raking line + a gutter-clean line). Treat each thing joined by "and" / "also" / commas as a SEPARATE line item and process EVERY one. EFFICIENT FLOW for multiple items: (1) switch_room first if a room change was mentioned; (2) call search_catalog ONCE with the \`queries\` array containing every item (e.g. queries: ["leaves raked", "gutter cleaning 2 story"]) — this searches them all together; (3) propose_line for every item you have BOTH a confident match AND a quantity for — you can emit multiple propose_line calls in a single step. For a single item just use \`query\`.`,
    ``,
    `PARTIAL multi-item requests (CRITICAL — this is the #1 place mistakes happen): when a request has some items ready (confident match + quantity) and one or more still missing a quantity, you MUST, in the SAME turn: (a) call propose_line for every ready item right away, AND (b) ask ONE short question for the item(s) still missing a quantity. NEVER withhold a ready item just because a different item needs a question. And NEVER say you "have" / "got" / "have the X at N" about an item unless you have actually called propose_line for it — if you truly have it, propose it; if you are only asking about it, do not claim to have it. Example: "yard needs leaves raked and a gutter cleaning, 50 linear feet, two story" → propose_line the gutter clean (you have 50 LF) NOW, and in the same turn ask only "How many bags for the leaves?".`,
    ``,
    `ANSWERING YOUR OWN QUESTION: when you asked a quantity/clarifying question and the inspector replies (e.g. you asked "how many bags for the leaves rake?" and they say "three bags"), that reply is the missing value FOR THE ITEM YOU ASKED ABOUT. Immediately call propose_line for THAT item with the given value. Do NOT substitute a different item, and do NOT re-propose items you already added on a previous turn — scan the conversation above; anything you already proposed is done. After proposing the deferred item, re-read the inspector's ORIGINAL sentence and make sure every distinct item is now in, then give one short wrap-up.`,
    ``,
    `When you call propose_line, edit_line, or switch_room, do not write any sentence at all — the app shows/speaks the result itself. NEVER narrate what you are about to do or just did (no "I'll search for that", no "Let me add that", no "Added X"); narration after acting is confusing because the app already announced it. Only produce text when you genuinely need to ask the inspector a question. Keep questions very short and spoken-friendly. Never invent a code; only use codes from search_catalog.`,
    ``,
    `Domain term: "mist match" (often misheard/transcribed as "mismatch", "mismatched", or "missed match") is a PAINT blending line item. When you hear any of those, search the catalog for "mist match" paint — never interpret it as something being mismatched.`
  );
  return lines.join('\n');
}

function tools(rooms: { id: string; name: string }[] = []) {
  const base = [
    {
      name: 'search_catalog',
      description: 'Semantic search of the rate-card catalog for the line item(s) that best match what the inspector described. For a SINGLE item pass `query`. For MULTIPLE items in one request (e.g. "carpet and pad and paint two walls"), pass `queries` as an array — they are all searched in one call, returning a candidate set per query. Prefer the batch form when the inspector lists several items; it is much faster.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A single item to find, e.g. "gutter cleaning".' },
          queries: { type: 'array', items: { type: 'string' }, description: 'Several items to find at once, e.g. ["carpet and pad", "paint two walls"]. Use this for multi-item requests.' },
          categoryHint: { type: 'string', description: 'Optional category guess to bias results, e.g. "Gutters".' },
        },
      },
    },
    {
      name: 'get_line_details',
      description: 'Look up the unit of measure and description for a specific catalog line item code, to confirm details before proposing.',
      input_schema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'The line item code, e.g. "GUT1001".' } },
        required: ['code'],
      },
    },
    {
      name: 'propose_line',
      description: 'Add a new line item, once you have the code and quantity. Vendor and tenant percent default to "Vendor 1" and 100% unless the inspector stated otherwise. The app saves it automatically and announces it.',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Catalog line item code (from search_catalog).' },
          quantity: { type: 'number', description: 'Quantity in the item\'s unit of measure.' },
          vendor: { type: 'string', description: `Assigned vendor; one of: ${VENDORS.join(', ')}. Omit to use the default "Vendor 1".` },
          tenantBillBackPercent: { type: 'number', description: 'Tenant chargeback percent, 0-100 in steps of 5. Omit to use the default 100.' },
          note: { type: 'string', description: 'Optional short note for the line.' },
        },
        required: ['code', 'quantity'],
      },
    },
    {
      name: 'edit_line',
      description: 'Edit an EXISTING line item in this area (change its vendor, tenant percent, and/or quantity). Use the externalId from the existing-lines list. The app saves the change and announces it.',
      input_schema: {
        type: 'object',
        properties: {
          externalId: { type: 'string', description: 'The id of the existing line to change (from the existing-lines list).' },
          quantity: { type: 'number', description: 'New quantity (omit to keep current).' },
          vendor: { type: 'string', description: `New vendor, one of: ${VENDORS.join(', ')} (omit to keep current).` },
          tenantBillBackPercent: { type: 'number', description: 'New tenant percent, 0-100 step 5 (omit to keep current).' },
        },
        required: ['externalId'],
      },
    },
  ];
  // Only offer room navigation when there's more than one room to move between.
  if (rooms.length > 1) {
    base.push({
      name: 'switch_room',
      description: 'Change which room/area the inspector is working on (e.g. "close this out and go to Bedroom 2", "let\'s do the kitchen next"). Resolve the inspector\'s phrasing to one of the room ids below. After switching, line items will be added to the new room. Only call this when the inspector clearly asks to move to a different room.',
      input_schema: {
        type: 'object',
        properties: {
          roomId: {
            type: 'string',
            description: `The id of the room to switch to. Available rooms (id → name): ${rooms.map((r) => `${r.id} → ${r.name}`).join('; ')}.`,
          },
        },
        required: ['roomId'],
      },
    } as any);
  }
  return base;
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function lineToSummary(
  item: RateCardLineItem,
  qty: number,
  vendor: string,
  pct: number,
  region: string,
  regions: RegionRate[]
): string {
  let vendorCostStr = '';
  try {
    const calc = calculateLine(item, region, regions, { quantity: qty, tenantBillBackPercent: pct });
    vendorCostStr = ` — Vendor ${money(calc.vendorCost)}`;
  } catch { /* if calc fails, omit the cost rather than block the line */ }
  return `${item.laborShortDescription} — ${qty} ${item.laborMeas || 'EA'}, ${vendor}, ${pct}% Tenant${vendorCostStr}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  // Warm-up ping (GET): pre-load the expensive cold-start work — the catalog
  // and its embeddings — so the inspector's FIRST spoken line is fast. No LLM
  // call, so it's cheap. The client fires this when the voice panel opens.
  if (req.method === 'GET') {
    try {
      const catalog = await fetchRateCardCatalog();
      await getCatalogEmbeddings(catalog); // builds/loads the vector cache
      // Also warm the Voyage QUERY path + region cache so the first real
      // utterance doesn't pay cold-start latency on either.
      await Promise.allSettled([
        matchCatalog('warmup', catalog, { topK: 1 }),
        getCachedRegions(),
      ]);
      return res.status(200).json({ warm: true, items: catalog.length });
    } catch (e: any) {
      // Warm-up failure is non-fatal; the real request will surface errors.
      return res.status(200).json({ warm: false, error: String(e?.message || e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Stream the response as Server-Sent Events. Text deltas (clarify questions /
  // preamble) flow to the client as they generate; the final resolution is sent
  // as a 'question' | 'proposal' | 'message' event, then 'done'.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const body = req.body as BodyShape;
    const clientMessages = Array.isArray(body?.messages) ? body.messages : [];
    if (clientMessages.length === 0) {
      sse(res, 'error', { error: 'No messages' });
      sse(res, 'done', {});
      return res.end();
    }

    const catalog = await fetchRateCardCatalog();
    const byCode = new Map(catalog.map((c) => [c.lineItemCode, c]));
    const regions = await getCachedRegions().catch(() => [] as RegionRate[]);
    const region = body.region || '';
    const currentLines: CurrentLine[] = Array.isArray(body?.currentLines) ? body.currentLines : [];
    const linesByExternalId = new Map(currentLines.map((l) => [l.externalId, l]));

    const messages: any[] = clientMessages.map((m) => ({ role: m.role, content: m.content }));
    // Room navigation context.
    const rooms: { id: string; name: string }[] = Array.isArray(body?.rooms)
      ? body.rooms.filter((r: any) => r && r.id).map((r: any) => ({ id: String(r.id), name: String(r.name || r.id) }))
      : [];
    const currentRoom = String(body?.currentRoom || body?.location || body?.section || '');
    const roomTools = tools(rooms);
    const system = systemPrompt(body.section || '', body.location || '', describeLines(byCode, currentLines), currentRoom, rooms);

    // The room a newly-proposed line belongs to. switch_room updates these so a
    // line added AFTER a switch is written to the new room, not the old one.
    // The client sends section+location for the room it currently shows; when
    // the agent switches rooms mid-turn we use the switched-to room's NAME for
    // both (the client resolves sectionId from the navigate event and the line's
    // section/location are matched back by the existing label||location lookup).
    let activeSection = body.section || '';
    let activeLocation = body.location || '';
    // Map room id/name -> the section + location to stamp on lines for that room.
    // The client passes rooms as {id, name}; for repeating rooms the name is the
    // location (e.g. "Bedroom 2") and for static rooms it's the label.

    let usedSearchThisTurn = false;
    // Whether the agent performed any action (add/edit/switch) this turn. If so,
    // a tool-free final round is a wrap-up message; if not, it's a question.
    let didAct = false;

    // --- Speculative pre-search (latency optimization) -------------------
    // The dominant cost is two sequential model round-trips: round 1 decides to
    // search, round 2 proposes after seeing candidates. For the common case
    // (the inspector names item(s) to add) we can run the catalog search up
    // front — in parallel for multiple items — and hand the candidates to the
    // model in the system prompt, so it can propose in ROUND 1. The model can
    // still call search_catalog for anything not covered. We only do this on a
    // fresh user turn (last message is the user's), and skip it for obvious
    // edits ("make that 50%") where no catalog lookup is needed.
    let preSearchBlock = '';
    try {
      const lastMsg = clientMessages[clientMessages.length - 1];
      const utter = lastMsg && lastMsg.role === 'user' ? String(lastMsg.content || '') : '';
      const looksLikeEdit = /\b(make (it|that)|change (it|that|the)|set (it|that)|that should be|instead|tenant|percent|vendor)\b/i.test(utter)
        && !/\b(add|install|replace|need|put in)\b/i.test(utter);
      if (utter && utter.length >= 3 && !looksLikeEdit) {
        // Split on "and"/"also"/commas into candidate item phrases (cheap heuristic;
        // the model still owns the final decomposition).
        const phrases = utter
          .split(/\b(?:and then|and also|and|also|plus|,)\b/i)
          .map((s) => s.trim())
          .filter((s) => s.length >= 3)
          .slice(0, 5);
        const queries = phrases.length ? phrases : [utter];
        const matches = await Promise.all(
          queries.map((q) => matchCatalog(q, catalog, { topK: 5, sectionName: activeSection || body.section || '' }).then((r) => ({ q, r })).catch(() => null))
        );
        const blocks: string[] = [];
        for (const m of matches) {
          if (!m || !m.r.confident || !m.r.candidates.length) continue;
          const top = m.r.candidates.slice(0, 4).map((c) =>
            `${c.item.lineItemCode} — ${c.item.laborShortDescription} [${c.item.category}/${c.item.subcategory}, ${c.item.laborMeas}]`
          ).join('; ');
          blocks.push(`"${m.q}" → ${top}`);
        }
        if (blocks.length) {
          preSearchBlock = [
            ``,
            `LIKELY CATALOG MATCHES (pre-searched for this request — use these to propose directly without calling search_catalog again, IF one clearly fits; otherwise call search_catalog yourself):`,
            ...blocks.map((b) => `  - ${b}`),
          ].join('\n');
        }
      }
    } catch { /* pre-search is best-effort; the model can still search */ }

    const systemWithHints = preSearchBlock ? `${system}\n${preSearchBlock}` : system;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Round 0 always uses the smart model. After that, the smart model is only
      // needed if a fresh catalog search happened (interpreting candidates).
      const model = round === 0 || usedSearchThisTurn ? MODEL_SMART : MODEL_FAST;

      // Stream this model call; forward text deltas live to the client.
      const { content } = await streamAnthropic(
        { model, max_tokens: 1024, system: systemWithHints, tools: roomTools, messages },
        (chunk) => sse(res, 'delta', { text: chunk })
      );

      const toolUses = content.filter((c) => c.type === 'tool_use');
      const textBlocks = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

      // No more tool calls -> the agent is done for this turn.
      if (toolUses.length === 0) {
        if (didAct) {
          // It acted (and may add a brief wrap-up). The client synthesizes the
          // spoken summary of what changed; pass any text along as a message.
          sse(res, 'message', { text: textBlocks || '', awaitingReply: true });
        } else {
          // It only wants more info — a clarifying question.
          sse(res, 'question', { text: textBlocks || 'Could you tell me more?', awaitingReply: true });
        }
        sse(res, 'done', {});
        return res.end();
      }

      usedSearchThisTurn = false;
      messages.push({ role: 'assistant', content });
      const toolResults: any[] = [];

      for (const tu of toolUses) {
        if (tu.name === 'search_catalog') {
          usedSearchThisTurn = true;
          const hint = tu.input?.categoryHint ? String(tu.input.categoryHint) : undefined;
          const sectionName = activeSection || body.section || '';
          // Batch form: an array of queries searched together.
          const queryList: string[] = Array.isArray(tu.input?.queries) && tu.input.queries.length
            ? tu.input.queries.map((x: any) => String(x)).filter(Boolean)
            : [String(tu.input?.query || '')].filter(Boolean);

          const runOne = async (q: string) => {
            const result = await matchCatalog(q, catalog, { topK: 8, categoryHint: hint, sectionName });
            return {
              query: q,
              confident: result.confident,
              candidates: result.candidates.map((m) => ({
                code: m.item.lineItemCode,
                description: m.item.laborShortDescription,
                category: m.item.category,
                subcategory: m.item.subcategory,
                unit: m.item.laborMeas,
              })),
              guidance: result.confident
                ? 'Top candidates look relevant.'
                : 'No strong match — none of these may be right. Confirm with the inspector or ask them to rephrase before proposing; do not assume.',
            };
          };

          const results = await Promise.all(queryList.map(runOne));
          // Single-query callers get the old flat shape; batch callers get `results`.
          const payload = results.length === 1
            ? results[0]
            : { results };
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(payload),
          });
        } else if (tu.name === 'get_line_details') {
          const code = String(tu.input?.code || '');
          const item = byCode.get(code);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: item
              ? JSON.stringify({ code, description: item.laborShortDescription, unit: item.laborMeas, category: item.category })
              : JSON.stringify({ error: `No catalog item with code ${code}` }),
          });
        } else if (tu.name === 'propose_line') {
          const code = String(tu.input?.code || '');
          const item = byCode.get(code);
          if (!item) {
            toolResults.push({
              type: 'tool_result', tool_use_id: tu.id, is_error: true,
              content: JSON.stringify({ error: `No catalog item with code ${code}. Use search_catalog first.` }),
            });
            continue;
          }
          const qty = Number(tu.input?.quantity);
          let vendor = tu.input?.vendor ? String(tu.input.vendor) : 'Vendor 1';
          if (!VENDORS.includes(vendor)) vendor = 'Vendor 1';
          let pct = tu.input?.tenantBillBackPercent != null ? Number(tu.input.tenantBillBackPercent) : 100;
          if (!isFinite(pct)) pct = 100;
          pct = Math.max(0, Math.min(100, Math.round(pct / 5) * 5));
          if (!isFinite(qty) || qty < 0) {
            toolResults.push({
              type: 'tool_result', tool_use_id: tu.id, is_error: true,
              content: JSON.stringify({ error: 'Quantity must be a non-negative number. Ask the inspector.' }),
            });
            continue;
          }

          const externalId = `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const line: RateCardLineInput = {
            externalId,
            section: activeSection,
            location: activeLocation,
            lineItemCode: code,
            quantity: qty,
            tenantBillBackPercent: pct,
            assignedTo: vendor,
            note: tu.input?.note ? String(tu.input.note) : '',
            photoUrls: [],
          };
          // Emit the line; the client auto-saves it to the active room. Then keep
          // the loop going so the agent can add MORE items in the same turn.
          sse(res, 'proposal', {
            action: 'add',
            line,
            summary: lineToSummary(item, qty, vendor, pct, region, regions),
            spokenSummary: item.laborShortDescription,
            awaitingReply: false,
          });
          didAct = true;
          toolResults.push({
            type: 'tool_result', tool_use_id: tu.id,
            content: JSON.stringify({ ok: true, added: item.laborShortDescription, note: 'Line added. If the inspector listed more items, continue; otherwise stop.' }),
          });
          continue;
        } else if (tu.name === 'edit_line') {
          const externalId = String(tu.input?.externalId || '');
          const existing = linesByExternalId.get(externalId);
          if (!existing) {
            toolResults.push({
              type: 'tool_result', tool_use_id: tu.id, is_error: true,
              content: JSON.stringify({ error: `No existing line with id ${externalId}. Use an id from the existing-lines list.` }),
            });
            continue;
          }
          const item = byCode.get(existing.lineItemCode);
          // Start from the existing values; apply only the provided changes.
          let qty = existing.quantity;
          if (tu.input?.quantity != null) {
            const q = Number(tu.input.quantity);
            if (isFinite(q) && q >= 0) qty = q;
          }
          let vendor = existing.assignedTo || 'Vendor 1';
          if (tu.input?.vendor != null) {
            const v = String(tu.input.vendor);
            vendor = VENDORS.includes(v) ? v : vendor;
          }
          let pct = existing.tenantBillBackPercent;
          if (tu.input?.tenantBillBackPercent != null) {
            let p = Number(tu.input.tenantBillBackPercent);
            if (isFinite(p)) pct = Math.max(0, Math.min(100, Math.round(p / 5) * 5));
          }
          // Re-save with the SAME externalId so the existing record is updated.
          const line: RateCardLineInput = {
            externalId,
            section: body.section || '',
            location: body.location || '',
            lineItemCode: existing.lineItemCode,
            quantity: qty,
            tenantBillBackPercent: pct,
            assignedTo: vendor,
            note: '',
            photoUrls: [],
          };
          sse(res, 'proposal', {
            action: 'edit',
            line,
            summary: item ? lineToSummary(item, qty, vendor, pct, region, regions) : `${existing.lineItemCode} — ${qty}, ${vendor}, ${pct}% Tenant`,
            spokenSummary: item ? item.laborShortDescription : existing.lineItemCode,
            awaitingReply: false,
          });
          didAct = true;
          toolResults.push({
            type: 'tool_result', tool_use_id: tu.id,
            content: JSON.stringify({ ok: true, edited: existing.lineItemCode, note: 'Line updated. Continue if more was requested; otherwise stop.' }),
          });
          continue;
        } else if (tu.name === 'switch_room') {
          const roomId = String(tu.input?.roomId || '');
          const room = rooms.find((r) => r.id === roomId)
            || rooms.find((r) => r.name.toLowerCase() === roomId.toLowerCase());
          if (!room) {
            toolResults.push({
              type: 'tool_result', tool_use_id: tu.id, is_error: true,
              content: JSON.stringify({ error: `No room matching "${roomId}". Available: ${rooms.map((r) => r.name).join(', ')}.` }),
            });
            continue;
          }
          // Tell the client to switch rooms (it scrolls/expands). The active room
          // for any subsequent propose_line in THIS turn is now the new one.
          sse(res, 'navigate', { sectionId: room.id, roomName: room.name });
          activeLocation = room.name;
          activeSection = room.name;
          didAct = true;
          toolResults.push({
            type: 'tool_result', tool_use_id: tu.id,
            content: JSON.stringify({ ok: true, switchedTo: room.name, note: 'Now working in this room. If the inspector also asked to add or change a line, continue with that now.' }),
          });
          continue;
        } else {
          toolResults.push({
            type: 'tool_result', tool_use_id: tu.id, is_error: true,
            content: JSON.stringify({ error: `Unknown tool ${tu.name}` }),
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    sse(res, 'message', { text: "I couldn't pin that down. Try rephrasing what's needed, or add it manually." });
    sse(res, 'done', {});
    return res.end();
  } catch (e: any) {
    console.error('POST /api/rate-card/voice-assist failed:', e);
    try {
      sse(res, 'error', { error: String(e?.message || e) });
      sse(res, 'done', {});
      return res.end();
    } catch {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }
}
