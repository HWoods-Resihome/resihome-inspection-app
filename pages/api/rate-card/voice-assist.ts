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
import { matchCatalog, getCatalogEmbeddings } from '@/lib/voiceCatalogMatch';
import { aliasFor } from '@/lib/voiceAliases';
import { depKindForCategory, depreciationTenantPct } from '@/lib/depreciation';
import { calculateLine } from '@/lib/rateCardMath';
import { getCachedRegions } from '@/pages/api/rate-card/regions';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { VENDORS } from '@/lib/vendors';
import type { RateCardLineItem, RateCardLineInput, RegionRate } from '@/lib/types';

// maxDuration: compound voice turns ("X and Y") run several tool rounds with the
// smart model and can take 30-40s; without this, Vercel kills the function early.
export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '1mb' } } };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// Two-model split. The heavy semantic matching is done by Voyage embeddings
// (pre-search), so the model's job each turn is light: pick the right candidate,
// pull the quantity, and emit the tool call. Sonnet handles that well and is far
// faster than Opus — the main latency lever. Haiku handles trivial clarify turns.
const MODEL_SMART = 'claude-sonnet-4-6';
const MODEL_FAST = 'claude-haiku-4-5-20251001';
const MAX_TOOL_ROUNDS = 8; // safety cap on tool loops per turn (compound requests: switch + multiple items)

interface ClientMessage { role: 'user' | 'assistant'; content: string; }
interface CurrentLine {
  externalId: string;
  lineItemCode: string;
  quantity: number;
  assignedTo: string;
  tenantBillBackPercent: number;
  // Bid-item fields, carried so edits preserve them.
  customVendorCost?: number | null;
  customLaborFullDescription?: string | null;
  note?: string;
}
interface BodyShape {
  messages: ClientMessage[];
  section: string;
  location: string;
  region: string;
  currentLines?: CurrentLine[];
  rooms?: { id: string; name: string }[];
  currentRoom?: string;
  tenantMonths?: number;
}

// Pick the catalog's bid-item line to use for a voice bid item. Prefers a code
// whose category/subcategory matches the inspector's trade hint, else a generic
// one, else the first active bid item. Returns null if the catalog has none.
function resolveBidItem(catalog: RateCardLineItem[], categoryHint?: string): RateCardLineItem | null {
  const bids = catalog.filter((c) => c.isBidItem && c.isActive !== false);
  if (!bids.length) return null;
  const hint = (categoryHint || '').trim().toLowerCase();
  if (hint) {
    const match = bids.find((c) => (c.category || '').toLowerCase() === hint)
      || bids.find((c) => (c.category || '').toLowerCase().includes(hint) || hint.includes((c.category || '').toLowerCase()));
    if (match) return match;
  }
  const generic = bids.find((c) => /general|misc|other/i.test(`${c.category} ${c.subcategory}`));
  return generic || bids[0];
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
  onTextDelta: (chunk: string) => void,
  // Called the instant a tool_use block finishes streaming (its input JSON is
  // complete). Lets the caller act on a tool — e.g. emit a proposal — before the
  // whole response finishes, so on a multi-item turn the lines pop in one-by-one.
  onToolComplete?: (block: any) => void
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
          try { onToolComplete?.(blocks[ev.index]); } catch { /* non-fatal */ }
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

// SSE comment heartbeat — keeps proxies/LTE intermediaries from dropping an
// idle stream during long gaps between model round-trips (catalog search +
// two model calls), which would otherwise hang the client in "Thinking…".
function sseHeartbeat(res: NextApiResponse) {
  try { res.write(': keep-alive\n\n'); } catch { /* stream closed */ }
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

// ── System prompt, split for prompt caching ─────────────────────────────────
// SYSTEM_RULES is room/line-independent, so it's byte-identical on every turn
// for every inspector. We send it as a cache_control'd block (below) so
// Anthropic reuses it across rounds, turns, AND users within the 5-minute
// window — giving round 0 of every utterance a warm cache, not just rounds 2+.
// The per-turn dynamic context (current room, room list, existing lines) goes
// in a separate, uncached block AFTER it.
const SYSTEM_RULES = [
  `You are a property inspector's voice assistant for a home inspection. You help manage Scope rate-card line items hands-free as the inspector walks the home. Speed matters — keep them moving.`,
  ``,
  `Defaults (apply silently unless the inspector says otherwise):`,
  `  - Vendor: "Vendor 1".  - Tenant chargeback: 100%.  - Size/level: standard / regular.`,
  `Never ask about vendor or tenant percent. Only use a different value if the inspector states one (e.g. "assign to PPW", "50 percent tenant").`,
  `TENANT % for PAINT and FLOORING items: do NOT set tenantBillBackPercent on propose_line for paint or flooring lines unless the inspector explicitly states a percent — the app auto-applies the depreciation schedule for those. For all other items, omit it too (defaults to 100). Only pass tenantBillBackPercent when the inspector actually says a number.`,
  `STYLE: flat and terse. The app announces every add/edit and speaks it, so you almost never need to speak. When you must, it is ONE short question — no greetings, no "Great"/"Got it", no recapping what you did. Just the question.`,
  ``,
  `ADDING a line:`,
  `1. Use search_catalog to find the line item matching what they described.`,
  `   - search_catalog returns a "confident" flag. If it's false, the catalog has no strong match — do NOT propose a guess. Briefly tell the inspector you're not sure that's in the catalog and ask them to rephrase or describe it differently.`,
  `2. Only ask a clarifying question if genuinely ambiguous (e.g. which of two distinct items). One short question, then proceed.`,
  `3. QUANTITY & UNIT — use the matched item's unit of measure (the "unit" field from search_catalog); never guess a unit:`,
  `   - EACH / count units (EA, "each", per-fixture): default the quantity to 1 and propose immediately. Do NOT ask "how many" — e.g. "snake the toilet" is 1 EA, just add it.`,
  `   - MEASURED units (LF linear feet, SF square feet, SY, etc.): NEVER guess or default the quantity. If the inspector gave a number, use it and set quantityConfirmed: true. If they did NOT give a number, you MUST ask ONCE, naming the item's ACTUAL unit (e.g. "How many square feet for the carpet?") — do not propose it until they answer. NEVER ask for a unit the item doesn't use (never ask linear feet for an EA item). Example: "replace the carpet" with no size → ask "How many square feet?" before proposing.`,
  `   - Whole House SF items: auto-filled with the property square footage — never ask; just propose (quantity 1 is fine, the app substitutes the SF).`,
  `   - STAIRS: carpet/tread/runner on stairs is priced PER STAIR (even though the unit reads "each"), so the quantity is the NUMBER OF STAIRS. If the inspector didn't say how many, ask "How many stairs?" before proposing — never default it to 1.`,
  `SIZE / TIER variants: many items come in size or level variants. ALWAYS default to the lowest / standard tier and propose it — for CLEANS ("sales clean", "turn clean") that means LEVEL 1 (never Level 2 unless the inspector says "level 2"); for rooms, the standard / regular size. Do NOT ask the inspector to choose a size or level — only use a higher tier when they explicitly say so ("level 2", "large room", "deep").`,
  ``,
  `ONE request = ONE line. NEVER add two or three variants of the SAME requested item (e.g. trash-out small AND medium AND large). If the catalog returns several distinct sizes/scopes for one request: for routine size tiers, pick the standard/lowest per the rule above; but when the right choice genuinely depends on the property and can't be defaulted (most notably TRASH-OUT / debris haul, where it's small vs medium vs large by volume), ask ONE short question to pick the size, then propose that single line. Do not add multiple options for the inspector to sort out later.`,
  ``,
  `TRASH-OUT: a trash out / debris removal / haul-away is the labor line only. Do NOT also add a dumpster (or roll-off / container) line unless the inspector explicitly says "dumpster". Ask which trash-out size (small/medium/large or the volume) before adding, and add just that one line.`,
  `4. When you have a code and quantity AND the match is confident, call propose_line. The app adds the line automatically and announces it — you do NOT need the inspector to say yes first, and you must NOT claim you added it in your own words. If the match is not confident (see step 1), ask first instead of proposing.`,
  ``,
  `EDITING an existing line (e.g. "make that 50% tenant", "change the paint line to PPW", "that should be 3 not 1"):`,
  `  - Identify which existing line they mean (the most recent one if they say "that"/"the last one", or by description). Use the id from the existing-lines list below.`,
  `  - Call edit_line with that externalId and only the fields to change. The app saves and announces it.`,
  ``,
  `The inspector may ask for SEVERAL things in one breath — e.g. "I'm back in the kitchen, replace the black microwave" (switch room + add a line), "add a new water heater and replace the kitchen faucet" (two lines), or "the yard needs leaves raked and a gutter cleaning, 50 linear feet, two story" (TWO separate items: a leaf-raking line + a gutter-clean line). Treat each thing joined by "and" / "also" / commas as a SEPARATE line item and process EVERY one. EFFICIENT FLOW for multiple items: (1) switch_room first if a room change was mentioned; (2) call search_catalog ONCE with the \`queries\` array containing every item (e.g. queries: ["leaves raked", "gutter cleaning 2 story"]) — this searches them all together; (3) propose_line for every item you have BOTH a confident match AND a quantity for — you can emit multiple propose_line calls in a single step. For a single item just use \`query\`.`,
  ``,
  `MULTIPLE ROOMS in one request: the inspector can name a different room per item — e.g. "add two light bulbs in the kitchen and a drywall repair in the hallway". Handle this WITHOUT switch_room: call propose_line once per item and set its \`room\` to that item's named room (room:"Kitchen" for the bulbs, room:"Hallway" for the drywall). Match each phrase's room to the closest name in the rooms list. Only use switch_room when the inspector is clearly moving themselves ("let's go to the kitchen"), not when merely attributing a line to a room.`,
  `ROUTE BY NAMED LOCATION: whenever the request names a place — even as the location of the work, without saying "in the" or "go to" — set that line's \`room\` to the matching room. E.g. "carpet on the stairs" → room "Hallway / Stairs"; "paint the garage" → "Garage"; "patch the ceiling in the basement" → "Basement". Match location words (stairs, garage, hallway, basement, attic, patio, etc.) to the closest room in the rooms list and route there; do NOT leave it in the current room just because the inspector didn't phrase it as a room change.`,
  ``,
  `PARTIAL multi-item requests (CRITICAL — this is the #1 place mistakes happen): when a request has some items ready (confident match + quantity) and one or more still missing a quantity, you MUST, in the SAME turn: (a) call propose_line for every ready item right away, AND (b) ask ONE short question for the item(s) still missing a quantity. NEVER withhold a ready item just because a different item needs a question. And NEVER say you "have" / "got" / "have the X at N" about an item unless you have actually called propose_line for it — if you truly have it, propose it; if you are only asking about it, do not claim to have it. Example: "yard needs leaves raked and a gutter cleaning, 50 linear feet, two story" → propose_line the gutter clean (you have 50 LF) NOW, and in the same turn ask only "How many bags for the leaves?".`,
  ``,
  `ANSWERING YOUR OWN QUESTION: when you asked a quantity/clarifying question and the inspector replies (e.g. you asked "how many bags for the leaves rake?" and they say "three bags"), that reply is the missing value FOR THE ITEM YOU ASKED ABOUT. Immediately call propose_line for THAT item with the given value. Do NOT substitute a different item, and do NOT re-propose items you already added on a previous turn — scan the conversation above; anything you already proposed is done. After proposing the deferred item, re-read the inspector's ORIGINAL sentence and make sure every distinct item is now in, then give one short wrap-up.`,
  ``,
  `CRITICAL — promised vs. proposed: if you SAY you will add something ("I'll add the wipe-down now"), you MUST emit a propose_line for it in that SAME turn. Never describe an add without making the tool call. And when the inspector then answers a clarifying question, that answer is for the ITEM YOU ASKED ABOUT (e.g. you asked about the paint scope → propose the PAINT line) — do not instead (re)add the other item you already mentioned. Before ending any turn, mentally check off EVERY distinct item in the inspector's request and make sure each one has its own propose_line; if one was dropped, add it now. EA/count items (e.g. "paint four walls" → a room-paint line is EA) default to quantity 1 — propose them, don't drop them while handling a measured item.`,
  ``,
  `When you call propose_line, edit_line, or switch_room, do not write any sentence at all — the app shows/speaks the result itself. NEVER narrate what you are about to do or just did (no "I'll search for that", no "Let me add that", no "Added X"); narration after acting is confusing because the app already announced it. Only produce text when you genuinely need to ask the inspector a question. Keep questions very short and spoken-friendly. Never invent a code; only use codes from search_catalog.`,
  ``,
  `BID ITEMS (important): when the inspector says "bid item" or "bid" — e.g. "bid item in the kitchen to replace the garbage disposal and re-caulk the sink" — this is NOT a catalog search. Use the propose_bid_item tool. The words after "to"/"for" are the WORK DESCRIPTION that the vendor will see, so pass them as \`description\` exactly as said (clean up only filler words). Two rules: (1) a bid item ALWAYS needs a price — if the inspector did not state one, do NOT add the line yet; instead ask, proposing a reasonable figure for the described work: "Does $150 work for this bid item?". When they answer with a number (or "yes"), THEN call propose_bid_item with that price. If they DID state a price ("...for two fifty"), call propose_bid_item right away with it. (2) This is the ONE case where, right after adding, you SHOULD briefly speak the price you used so they can change it — e.g. "Added the kitchen bid item at $250 — tell me if you want a different price." To change a bid item's price or description later, use edit_line with \`price\` / \`description\`.`,
  ``,
  `Domain term: "mist match" (often misheard/transcribed as "mismatch", "mismatched", or "missed match") is a PAINT blending line item. When you hear any of those, search the catalog for "mist match" paint — never interpret it as something being mismatched.`,
  ``,
  `WHOLE-HOUSE CLEAN: "sales clean", "turn clean", "full house clean", "whole house clean", "house clean", or "clean the whole house" = ONE whole-house cleaning line. Default to LEVEL 1 unless the inspector explicitly says "level 2". It belongs in the WHOLE HOUSE room/section if the inspection has one — switch_room there first, then add the single line. search_catalog for the whole-house "Sales Clean" / "Turn Clean" line and propose that ONE line. NEVER break a whole-house/full-house clean into multiple per-room cleaning items (e.g. "Cleaning of Entry", "Appliances Clean Per Unit") — that is wrong; it is a single whole-house line.`,
].join('\n');

// Per-turn dynamic context (NOT cached): current room, the room list, and the
// existing lines in this area. Sent as a second system block after SYSTEM_RULES.
function systemContext(
  section: string,
  location: string,
  linesDesc: string,
  currentRoom: string,
  rooms: { id: string; name: string }[] = []
): string {
  const loc = location || section;
  const roomName = currentRoom || loc;
  const lines = [
    `You are currently working on the "${roomName}" room/area. Line items you add or edit go to THIS room.`,
  ];
  if (rooms.length > 1) {
    lines.push(
      ``,
      `ROOMS in this inspection: ${rooms.map((r) => r.name).join(', ')}.`,
      `The inspector can move you between rooms. When they say things like "close this out and go to Bedroom 2", "let's do the kitchen", "next room, primary bath", call switch_room with the matching room id. Resolve natural phrasing to the closest room name. After a successful switch, the app moves the form to that room and greets the inspector — you do NOT need to add anything. Only switch when they clearly ask to change rooms; if they're describing damage, that's a line item, not a room change.`
    );
  }
  if (linesDesc && linesDesc.trim()) lines.push(``, linesDesc);
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
          quantityConfirmed: { type: 'boolean', description: 'Set true ONLY when the inspector actually stated/confirmed the measured amount (e.g. they said "200 square feet"). For measured-unit items (SF/LF/SY) you MUST NOT guess or default the quantity — leave this false (or omit) and ask the inspector for the measurement first. Count/EA items don\'t need this.' },
          vendor: { type: 'string', description: `Assigned vendor; one of: ${VENDORS.join(', ')}. Omit to use the default "Vendor 1".` },
          tenantBillBackPercent: { type: 'number', description: 'Tenant chargeback percent, 0-100 in steps of 5. Omit to use the default 100.' },
          note: { type: 'string', description: 'Optional short note for the line.' },
          room: { type: 'string', description: 'Room/area this line belongs to (a name from the rooms list). Omit to use the current room. SET THIS to add lines to DIFFERENT rooms in one request — e.g. "two bulbs in the kitchen and drywall repair in the hallway" → propose_line(...bulbs, room:"Kitchen") AND propose_line(...drywall, room:"Hallway"). With a per-line room you do NOT need switch_room.' },
        },
        required: ['code', 'quantity'],
      },
    },
    {
      name: 'propose_bid_item',
      description: 'Add a BID ITEM: a custom-priced line for work that is quoted/bid rather than priced from the catalog. Use this whenever the inspector says "bid item" / "bid" (e.g. "bid item in the kitchen to replace the disposal and re-caulk the sink"). The words the inspector says describing the work become the vendor-visible line description, so capture them verbatim. You MUST have a price before calling this: if the inspector did not state one, DO NOT call this yet — first ask them, proposing a figure, e.g. "Does $150 work for this bid item?". Call this only once you have a price the inspector gave or agreed to.',
      input_schema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'The work description in the inspector\'s own words (what they said after "to"/"for"). This is shown to the vendor, so keep it complete and specific. Required.' },
          price: { type: 'number', description: 'The bid price in dollars (the vendor cost for this line). Required — get the inspector to state or agree to a number first.' },
          room: { type: 'string', description: 'Room/area this bid item belongs to (a name from the rooms list). Omit to use the current room.' },
          vendor: { type: 'string', description: `Assigned vendor; one of: ${VENDORS.join(', ')}. Omit to use the default "Vendor 1".` },
          tenantBillBackPercent: { type: 'number', description: 'Tenant chargeback percent 0-100 step 5. Omit to default to 100.' },
          categoryHint: { type: 'string', description: 'Optional trade for the bid item, e.g. "Plumbing", "Electrical", "General", to pick the closest bid-item category.' },
        },
        required: ['description', 'price'],
      },
    },
    {
      name: 'edit_line',
      description: 'Edit an EXISTING line item in this area (change its vendor, tenant percent, quantity, and — for bid items — its price or description). Use the externalId from the existing-lines list. The app saves the change and announces it.',
      input_schema: {
        type: 'object',
        properties: {
          externalId: { type: 'string', description: 'The id of the existing line to change (from the existing-lines list).' },
          quantity: { type: 'number', description: 'New quantity (omit to keep current).' },
          vendor: { type: 'string', description: `New vendor, one of: ${VENDORS.join(', ')} (omit to keep current).` },
          tenantBillBackPercent: { type: 'number', description: 'New tenant percent, 0-100 step 5 (omit to keep current).' },
          price: { type: 'number', description: 'New bid price in dollars (bid items only; omit to keep current).' },
          description: { type: 'string', description: 'New vendor-visible description (bid items only; omit to keep current).' },
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
      const catalog = await getCachedCatalog();
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

    const catalog = await getCachedCatalog();
    const byCode = new Map(catalog.map((c) => [c.lineItemCode, c]));
    const regions = await getCachedRegions().catch(() => [] as RegionRate[]);
    const region = body.region || '';
    const tenantMonthsRaw = Number(body?.tenantMonths);
    const tenantMonths = Number.isFinite(tenantMonthsRaw) && tenantMonthsRaw > 0 ? tenantMonthsRaw : 12;
    const currentLines: CurrentLine[] = Array.isArray(body?.currentLines) ? body.currentLines : [];
    const linesByExternalId = new Map(currentLines.map((l) => [l.externalId, l]));

    const messages: any[] = clientMessages.map((m) => ({ role: m.role, content: m.content }));
    // Room navigation context.
    const rooms: { id: string; name: string }[] = Array.isArray(body?.rooms)
      ? body.rooms.filter((r: any) => r && r.id).map((r: any) => ({ id: String(r.id), name: String(r.name || r.id) }))
      : [];
    const currentRoom = String(body?.currentRoom || body?.location || body?.section || '');
    const roomTools = tools(rooms);
    // Prompt caching: mark the (large, per-session-stable) tool definitions as a
    // cached prefix. Anthropic reuses them across every tool-loop round and
    // across turns within the 5-min window, cutting time-to-first-token and
    // input cost — meaningful when ~100 inspectors are dictating at once.
    if (roomTools.length) (roomTools[roomTools.length - 1] as any).cache_control = { type: 'ephemeral' };
    const sysContext = systemContext(body.section || '', body.location || '', describeLines(byCode, currentLines), currentRoom, rooms);

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
    // How many of the inspector's phrases got a CONFIDENT pre-search match. Used
    // as a guardrail: if the model tries to end the turn with a question without
    // having proposed any of these ready items, we nudge it to act first.
    let preSearchConfidentCount = 0;
    // True when the utterance is a single item that pre-search matched
    // confidently and it's not an edit — the easy, dominant case. We let the
    // FAST model handle round 0 here (real-time feel) because the heavy semantic
    // matching is already done and the accuracy-critical rules (measured-quantity
    // bounce, confidence gating, dropped-item nudge) are enforced server-side
    // regardless of model. Anything compound/ambiguous/edit stays on the smart
    // model, and if the fast model is unsure and calls search_catalog, the next
    // round escalates to smart automatically.
    let simpleConfidentAdd = false;
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
          queries.map((q) => {
            const alias = aliasFor(q);
            return matchCatalog(alias ? alias.query : q, catalog, { topK: 5, categoryHint: alias?.categoryHint, sectionName: activeSection || body.section || '' }).then((r) => ({ q, r })).catch(() => null);
          })
        );
        const blocks: string[] = [];
        for (const m of matches) {
          if (!m || !m.r.confident || !m.r.candidates.length) continue;
          const top = m.r.candidates.slice(0, 4).map((c) =>
            `${c.item.lineItemCode} — ${c.item.laborShortDescription} [${c.item.category}/${c.item.subcategory}, ${c.item.laborMeas}]`
          ).join('; ');
          blocks.push(`"${m.q}" → ${top}`);
        }
        preSearchConfidentCount = blocks.length;
        simpleConfidentAdd = queries.length === 1 && blocks.length === 1;
        if (blocks.length) {
          preSearchBlock = [
            ``,
            `LIKELY CATALOG MATCHES (pre-searched for this request — propose directly from these without calling search_catalog again when one clearly fits; otherwise call search_catalog yourself):`,
            ...blocks.map((b) => `  - ${b}`),
            ``,
            `CRITICAL — address EVERY phrase above in THIS turn. The inspector listed multiple items; do not stop after the first. In a single turn: call propose_line for each item that has a clear match AND a known/derivable quantity (EA/count items default to qty 1), AND ask ONE short question for any item that still needs a measured quantity (LF/SF). Do NOT say "anything else"/"done" or end the turn while any listed phrase is still unaddressed. Example: "paint the walls and replace carpet and pad" → propose_line the wall paint (1 EA) now, and in the same turn ask the carpet/pad square footage.`,
          ].join('\n');
        }
      }
    } catch { /* pre-search is best-effort; the model can still search */ }

    // Two system blocks: the large static rules (cached — hits across rounds,
    // turns, and users), then the per-turn dynamic context + pre-search hints
    // (uncached, since it changes every turn).
    const dynamicText = preSearchBlock ? `${sysContext}\n${preSearchBlock}` : sysContext;
    const systemWithHints = [
      { type: 'text', text: SYSTEM_RULES, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamicText },
    ];

    // One-time guardrail: if the model asks a question without first proposing
    // the items pre-search already matched confidently, we nudge it once to
    // propose those before it's allowed to end the turn.
    let nudgedToAct = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      sseHeartbeat(res); // keep the stream warm before each (possibly slow) round
      // Model selection, tuned for latency without losing accuracy:
      //  - Round 0: the FAST model for a single confidently-matched add (the
      //    common case — heavy matching already done by pre-search); otherwise
      //    the SMART model for compound/ambiguous/edit requests.
      //  - Later rounds: SMART only if a fresh catalog search happened this turn
      //    (interpreting candidates); else FAST.
      const model = round === 0
        ? (simpleConfidentAdd && !usedSearchThisTurn ? MODEL_FAST : MODEL_SMART)
        : (usedSearchThisTurn ? MODEL_SMART : MODEL_FAST);

      // Build the proposal + tool_result for ONE add tool (propose_line /
      // propose_bid_item). Used both incrementally (as the tool finishes
      // streaming) and from the post-round loop. Memoized by tool id so it runs
      // exactly once per tool — the early call emits the proposal SSE, the
      // post-round call just reuses the cached tool_result. Reads the live
      // activeSection/activeLocation, so a switch_room processed first still
      // routes correctly.
      const builtResults = new Map<string, any>();
      const emitAdd = (tu: any): any => {
        const cached = builtResults.get(tu.id);
        if (cached) return cached;
        let result: any;
        if (tu.name === 'propose_bid_item') {
          const description = String(tu.input?.description || '').trim();
          const price = Number(tu.input?.price);
          if (!description) {
            result = { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: 'A bid item needs a work description (what the vendor will see). Ask the inspector what the work is.' }) };
          } else if (!isFinite(price) || price < 0) {
            result = { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: 'A bid item needs a price. Do not add it yet — ask the inspector what price to use (you may propose one): "Does $X work for this bid item?", then call propose_bid_item with that price.', needsPrice: true }) };
          } else {
            const bid = resolveBidItem(catalog, tu.input?.categoryHint ? String(tu.input.categoryHint) : undefined);
            if (!bid) {
              result = { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: 'No bid-item line exists in the catalog, so a bid item cannot be added by voice.' }) };
            } else {
              let bidVendor = tu.input?.vendor ? String(tu.input.vendor) : 'Vendor 1';
              if (!VENDORS.includes(bidVendor)) bidVendor = 'Vendor 1';
              let bidPct = 100;
              if (tu.input?.tenantBillBackPercent != null && isFinite(Number(tu.input.tenantBillBackPercent))) {
                bidPct = Math.max(0, Math.min(100, Math.round(Number(tu.input.tenantBillBackPercent) / 5) * 5));
              }
              let bidSection = activeSection;
              let bidLocation = activeLocation;
              let bidSectionId: string | undefined;
              if (tu.input?.room) {
                const want = String(tu.input.room).trim().toLowerCase();
                const r = rooms.find((rm) => rm.id === String(tu.input.room))
                  || rooms.find((rm) => rm.name.toLowerCase() === want)
                  || rooms.find((rm) => rm.name.toLowerCase().includes(want) || want.includes(rm.name.toLowerCase()));
                if (r) { bidSection = r.name; bidLocation = r.name; bidSectionId = r.id; }
              }
              const bidPrice = Math.round(price * 100) / 100;
              const line: RateCardLineInput = {
                externalId: `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                section: bidSection, location: bidLocation, lineItemCode: bid.lineItemCode,
                quantity: 1, tenantBillBackPercent: bidPct, assignedTo: bidVendor,
                note: description, customVendorCost: bidPrice, customLaborFullDescription: description, photoUrls: [],
              };
              sse(res, 'proposal', { action: 'add', line, sectionId: bidSectionId, summary: `Bid item: ${description} — $${bidPrice.toFixed(2)} (${bidVendor}, ${bidPct}% Tenant)`, spokenSummary: 'bid item', awaitingReply: false });
              didAct = true;
              result = { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ ok: true, addedBidItem: description, price: bidPrice, note: 'Bid item added. Briefly tell the inspector the price you used so they can change it.' }) };
            }
          }
        } else {
          // propose_line
          const code = String(tu.input?.code || '');
          const item = byCode.get(code);
          if (!item) {
            result = { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: `No catalog item with code ${code}. Use search_catalog first.` }) };
          } else {
            const qty = Number(tu.input?.quantity);
            let vendor = tu.input?.vendor ? String(tu.input.vendor) : 'Vendor 1';
            if (!VENDORS.includes(vendor)) vendor = 'Vendor 1';
            const depKind = depKindForCategory(item.category, item.laborShortDescription);
            let pct: number;
            if (tu.input?.tenantBillBackPercent != null && isFinite(Number(tu.input.tenantBillBackPercent))) pct = Number(tu.input.tenantBillBackPercent);
            else if (depKind) pct = depreciationTenantPct(depKind, tenantMonths);
            else pct = 100;
            pct = Math.max(0, Math.min(100, Math.round(pct / 5) * 5));
            const unit = (item.laborMeas || '').trim().toUpperCase();
            const isMeasured = unit === 'SF' || unit === 'LF' || unit === 'SY';
            const isWholeHouse = /whole\s*house/i.test(activeSection || body.section || '');
            const confirmed = tu.input?.quantityConfirmed === true;
            // Stair items (carpet/tread/runner on stairs) are priced PER STAIR
            // even though the unit reads EACH, so a defaulted qty of 1 is almost
            // always wrong. Treat them like a measured item: require a confirmed
            // count of stairs before adding.
            const isStairCount = /\bstair/i.test(item.laborShortDescription);
            if (!isFinite(qty) || qty < 0) {
              result = { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: 'Quantity must be a non-negative number. Ask the inspector.' }) };
            } else if (isMeasured && !isWholeHouse && !confirmed) {
              const unitWord = unit === 'SF' ? 'square feet' : unit === 'LF' ? 'linear feet' : 'square yards';
              result = { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: `"${item.laborShortDescription}" is measured in ${unitWord}. Do not guess the amount. Ask the inspector to confirm the ${unitWord} (e.g. "How many ${unitWord} for the carpet?"), then call propose_line again with the stated quantity and quantityConfirmed: true.`, needsQuantity: true, unit }) };
            } else if (isStairCount && !confirmed) {
              result = { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: `"${item.laborShortDescription}" is priced per stair. Do not guess. Ask the inspector how many stairs (e.g. "How many stairs?"), then call propose_line again with that count as the quantity and quantityConfirmed: true.`, needsQuantity: true, unit: 'stairs' }) };
            } else {
              let lineSection = activeSection;
              let lineLocation = activeLocation;
              let lineSectionId: string | undefined;
              if (tu.input?.room) {
                const want = String(tu.input.room).trim().toLowerCase();
                const r = rooms.find((rm) => rm.id === String(tu.input.room))
                  || rooms.find((rm) => rm.name.toLowerCase() === want)
                  || rooms.find((rm) => rm.name.toLowerCase().includes(want) || want.includes(rm.name.toLowerCase()));
                if (r) { lineSection = r.name; lineLocation = r.name; lineSectionId = r.id; }
              }
              const line: RateCardLineInput = {
                externalId: `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                section: lineSection, location: lineLocation, lineItemCode: code,
                quantity: qty, tenantBillBackPercent: pct, assignedTo: vendor,
                note: tu.input?.note ? String(tu.input.note) : '', photoUrls: [],
              };
              sse(res, 'proposal', { action: 'add', line, sectionId: lineSectionId, summary: lineToSummary(item, qty, vendor, pct, region, regions), spokenSummary: item.laborShortDescription, awaitingReply: false });
              didAct = true;
              result = { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ ok: true, added: item.laborShortDescription, note: 'Line added. If the inspector listed more items, continue; otherwise stop.' }) };
            }
          }
        }
        builtResults.set(tu.id, result);
        return result;
      };

      // Incremental streaming: emit add proposals the instant the model finishes
      // each tool call, so multi-item turns ("add X and Y and Z") pop in one by
      // one. We do this ONLY for responses with no switch_room — when a switch
      // is present, room ordering matters, so we fall back to the post-round
      // pass (which processes switch_room first). search_catalog/edit are also
      // left to the post-round pass (they need results/ordering).
      let sawSwitchInResponse = false;
      const onToolComplete = (block: any) => {
        if (!block || block.type !== 'tool_use') return;
        if (block.name === 'switch_room') { sawSwitchInResponse = true; return; }
        if (sawSwitchInResponse) return;
        if (block.name === 'propose_line' || block.name === 'propose_bid_item') {
          try { emitAdd(block); } catch { /* fall back to the post-round pass */ }
        }
      };

      // Stream this model call; forward text deltas live to the client.
      const { content } = await streamAnthropic(
        { model, max_tokens: 1200, system: systemWithHints, tools: roomTools, messages },
        (chunk) => sse(res, 'delta', { text: chunk }),
        onToolComplete
      );

      const toolUses = content.filter((c) => c.type === 'tool_use');
      const textBlocks = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

      // No more tool calls -> the agent is done for this turn.
      if (toolUses.length === 0) {
        // GUARDRAIL: the model is trying to end the turn with a question, but it
        // never proposed the items pre-search matched confidently. This is the
        // #1 multi-item failure — it asks about the one item needing a measured
        // quantity and silently drops the ready ones. Force a round to propose
        // them first, then it can ask. Only do this once per turn.
        if (!didAct && preSearchConfidentCount > 0 && !nudgedToAct && round < MAX_TOOL_ROUNDS - 1) {
          nudgedToAct = true;
          messages.push({ role: 'assistant', content: textBlocks || '…' });
          messages.push({
            role: 'user',
            content:
              'You have not added any lines yet. For EVERY pre-searched match that is a count/EA item, call propose_line NOW (those default to quantity 1 — do not ask about them). Emit all those propose_line calls in this step. For any MEASURED item (SF/LF/SY) whose amount the inspector did NOT state, do NOT propose it — ask ONE short question for its measurement instead (e.g. "How many square feet for the carpet?"). Do not reply with text alone unless the only thing left is such a question.',
          });
          continue;
        }
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

      // Process switch_room BEFORE search/propose/edit so navigation and the
      // active room are set first — regardless of the order the model emitted the
      // tool calls. Otherwise a propose_line emitted before switch_room would
      // land the line in the previous room.
      // Explicit partition (clearer and order-guaranteed): every switch_room
      // first, then the rest in their original relative order.
      const orderedToolUses = [
        ...toolUses.filter((t) => t.name === 'switch_room'),
        ...toolUses.filter((t) => t.name !== 'switch_room'),
      ];

      for (const tu of orderedToolUses) {
        if (tu.name === 'search_catalog') {
          usedSearchThisTurn = true;
          const hint = tu.input?.categoryHint ? String(tu.input.categoryHint) : undefined;
          const sectionName = activeSection || body.section || '';
          // Batch form: an array of queries searched together.
          const queryList: string[] = Array.isArray(tu.input?.queries) && tu.input.queries.length
            ? tu.input.queries.map((x: any) => String(x)).filter(Boolean)
            : [String(tu.input?.query || '')].filter(Boolean);

          const runOne = async (q: string) => {
            // Normalize known phrasings (e.g. "sales clean" → "whole house sales
            // clean") so the matcher reliably finds the right line.
            const alias = aliasFor(q);
            const effQuery = alias ? alias.query : q;
            const effHint = hint || alias?.categoryHint;
            const result = await matchCatalog(effQuery, catalog, { topK: 8, categoryHint: effHint, sectionName });
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
        } else if (tu.name === 'propose_line' || tu.name === 'propose_bid_item') {
          // Build + emit (or reuse the already-streamed emit) and record the
          // tool_result in order. emitAdd is memoized by tool id, so a proposal
          // streamed incrementally above is not emitted again here.
          toolResults.push(emitAdd(tu));
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
          // Preserve existing bid-item fields; allow changing the price and/or
          // the vendor-visible description when provided.
          let bidCost = existing.customVendorCost ?? null;
          if (tu.input?.price != null) {
            const pc = Number(tu.input.price);
            if (isFinite(pc) && pc >= 0) bidCost = Math.round(pc * 100) / 100;
          }
          let bidDesc = existing.customLaborFullDescription ?? null;
          let bidNote = existing.note || '';
          if (tu.input?.description != null && String(tu.input.description).trim()) {
            bidDesc = String(tu.input.description).trim();
            bidNote = bidDesc;
          }
          // Re-save with the SAME externalId so the existing record is updated.
          const line: RateCardLineInput = {
            externalId,
            // Use the ACTIVE room (a mid-turn switch_room may have changed it),
            // matching propose_line — not the request's original room.
            section: activeSection,
            location: activeLocation,
            lineItemCode: existing.lineItemCode,
            quantity: qty,
            tenantBillBackPercent: pct,
            assignedTo: vendor,
            note: bidNote,
            customVendorCost: bidCost,
            customLaborFullDescription: bidDesc ?? undefined,
            photoUrls: [],
          };
          const editSummary = bidCost != null
            ? `Bid item: ${bidDesc || (item ? item.laborShortDescription : existing.lineItemCode)} — $${bidCost.toFixed(2)} (${vendor}, ${pct}% Tenant)`
            : item ? lineToSummary(item, qty, vendor, pct, region, regions) : `${existing.lineItemCode} — ${qty}, ${vendor}, ${pct}% Tenant`;
          sse(res, 'proposal', {
            action: 'edit',
            line,
            summary: editSummary,
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
