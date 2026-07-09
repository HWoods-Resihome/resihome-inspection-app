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
import { VENDORS } from '@/lib/vendors';
import { recordAiUsage } from '@/lib/aiUsage';
import {
  aliasFor, correctCleanLevel, correctBlinds, wholeHouseExempt,
  measuredUnitOf, measurementWord, isStairCount, resolveTenantPct,
} from '@/lib/rateCardAiCore';

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
  '',
  '=== CATALOG MAPPING REFERENCE ===',
  'This reference is STABLE GUIDANCE for translating what the inspector names or clearly shows into the closest catalog work phrase for the `query` field. It is NOT a checklist: never suggest an item just because it appears below — suggest ONLY work the inspector called out or damage plainly visible in the frame. Prefer the exact phrasing shown here, because it resolves cleanly against the catalog.',
  '',
  'PAINT & DRYWALL:',
  ' • "paint the wall" / "this wall" -> "paint wall"; "two walls" -> quantity 2 on "paint wall".',
  ' • "paint the room" / "whole room" / "paint everything in here" -> "paint whole room".',
  ' • "paint the ceiling" -> "paint ceiling"; "paint the trim / baseboards / doors" -> "paint trim".',
  ' • "touch up" / "color mismatch" / "mismatch" / "mist match" / "spot paint" -> "mist match paint".',
  ' • "sales paint" / "make-ready paint" / whole-property repaint -> "paint whole house" (WHOLE-HOUSE — see below).',
  ' • nail holes / small dents / "patch the wall" -> "drywall patch and paint"; large hole -> "drywall repair".',
  '',
  'FLOORING:',
  ' • carpet stained / torn / worn / "replace the carpet" -> "replace carpet".',
  ' • "clean the carpet" / "shampoo the carpet" -> "carpet cleaning".',
  ' • LVP / vinyl plank / laminate damaged or missing -> "replace LVP plank".',
  ' • tile cracked / chipped -> "replace tile"; grout dirty / cracked -> "regrout" or "clean grout".',
  ' • "replace the pad" / carpet padding -> "replace carpet pad".',
  '',
  'CLEANING (map the stated tier literally — do NOT upgrade or downgrade):',
  ' • "light clean" / "level 1 clean" -> level 1 clean.',
  ' • "deep clean" / "level 2 clean" / "heavy clean" -> level 2 clean.',
  ' • "sales clean" / "make ready clean" / "turn clean" -> whole-house sales clean (WHOLE-HOUSE).',
  ' • "clean the oven / fridge / tub / toilet / cabinets" -> the specific appliance/fixture clean.',
  '',
  'BLINDS & WINDOW COVERINGS:',
  ' • ANY broken / missing / bent / damaged blind -> EXACTLY "replace faux wood blind". Quantity = number of windows named.',
  ' • Only use valance / vertical blind / wand / cord if the inspector names that EXACT part.',
  '',
  'DOORS, HARDWARE & TRIM:',
  ' • door damaged / hollow-core hole -> "replace interior door"; "just the slab" -> "replace door slab".',
  ' • knob / lock / deadbolt / hinge issues -> "replace door hardware" / "replace deadbolt".',
  ' • baseboard / quarter-round / casing damaged -> "replace baseboard" (LF).',
  ' • "missing door stop" / "cabinet handle" -> the specific small-hardware item.',
  '',
  'PLUMBING & ELECTRICAL:',
  ' • leaky / broken faucet -> "replace faucet"; running / broken toilet -> "replace toilet" or "rebuild toilet".',
  ' • "P-trap" / "supply line" / "angle stop" -> that specific part.',
  ' • missing / broken outlet or switch cover -> "replace outlet cover" / "replace switch plate".',
  ' • outlet / switch not working -> "replace outlet" / "replace switch"; light fixture -> "replace light fixture".',
  ' • "bulb is out" / burned-out bulb -> "replace light bulb"; smoke/CO detector -> "replace smoke detector".',
  '',
  'APPLIANCES:',
  ' • damaged / missing range, fridge, dishwasher, microwave, disposal -> "replace <appliance>".',
  ' • "the disposal is jammed" -> "repair garbage disposal".',
  '',
  'EXTERIOR / YARD:',
  ' • "cut / mow the grass" -> "mow lawn"; "the grass is dead" -> "sod" or "reseed".',
  ' • "trim the bushes / shrubs / hedges" -> "shrub trimming"; "trim the tree" -> "tree trimming".',
  ' • "pull the weeds" / "weed the beds" -> "weeding"; "spread mulch" -> "mulch".',
  ' • "pressure wash" the driveway / siding -> "pressure washing".',
  ' • "haul off" junk / debris / "trash out" -> "trash out / debris removal".',
  '',
  'PEST: roaches / ants / rodents / "spray for bugs" -> "pest control treatment".',
  '',
  'VENDOR ASSIGNMENT:',
  ` • Allowed vendors: ${VENDORS.join(', ')}.`,
  ' • Leave the default vendor unless the inspector explicitly names one ("assign that to PPW" -> edit_line vendor "PPW").',
  '',
  'MEASURED-ITEM SIZING (SF/LF/EA):',
  ' • When the inspector does NOT state a quantity for a measured item, give estimatedQuantity — a rough, clearly-approximate size for them to confirm (quantityStated=false). Never present it as exact.',
  ' • Rough anchors (adjust to the visible room): single wall paint ≈ 120-160 SF; small whole-room paint ≈ 400-500 SF; average bedroom carpet ≈ 120-200 SF; baseboard per room ≈ 40-60 LF; standard interior door = 1 EA.',
  ' • COUNT/EA items (covers, bulbs, outlets, blinds, doors): quantity=1, quantityStated=true unless a count is stated.',
  '',
  'WHOLE-HOUSE items (paint whole house, whole-house sales clean, mist match whole house, full-property mow/trash-out) are billed ONCE for the property — NOT per room. Never emit a per-room quantity for them.',
  '',
  'KITCHEN:',
  ' • countertop chipped / burned / delaminating -> "replace countertop" (LF).',
  ' • cabinet door / drawer front damaged -> "replace cabinet door"; whole box damaged -> "replace cabinet".',
  ' • cabinet hinge / handle / knob -> "replace cabinet hardware".',
  ' • kitchen sink cracked / stained -> "replace kitchen sink"; sprayer / faucet -> "replace kitchen faucet".',
  ' • backsplash tile cracked / missing -> "replace backsplash tile".',
  ' • range hood / vent damaged -> "replace range hood".',
  '',
  'BATHROOM:',
  ' • vanity top / sink cracked -> "replace vanity top"; whole vanity -> "replace vanity".',
  ' • mirror cracked / missing -> "replace mirror"; medicine cabinet -> "replace medicine cabinet".',
  ' • toilet seat broken -> "replace toilet seat"; wax ring / running toilet -> "rebuild toilet".',
  ' • shower / tub surround cracked -> "replace tub surround"; tub chipped / worn -> "reglaze tub".',
  ' • shower door / glass damaged -> "replace shower door"; shower rod -> "replace shower rod".',
  ' • caulk moldy / missing around tub or sink -> "re-caulk"; towel bar / paper holder -> the specific accessory.',
  ' • exhaust fan not working / noisy -> "replace bath exhaust fan".',
  '',
  'WINDOWS & SCREENS:',
  ' • window glass cracked / foggy (seal failure) -> "replace window glass" / "replace window".',
  ' • window screen torn / missing -> "replace window screen" (EA per window).',
  ' • weatherstripping / window lock -> the specific part.',
  '',
  'HVAC & MECHANICAL:',
  ' • dirty / missing air filter -> "replace air filter" (match the property filter size when known).',
  ' • thermostat broken / missing -> "replace thermostat"; vent / register cover -> "replace vent cover".',
  ' • "the AC is not cooling" / "furnace not working" -> "HVAC service call" (a tech, not a part).',
  '',
  'LAUNDRY & GARAGE:',
  ' • dryer vent disconnected / lint-clogged -> "clean dryer vent" / "replace dryer vent".',
  ' • washer supply box / valve leaking -> "replace washer box".',
  ' • garage door panel damaged -> "replace garage door panel"; opener / spring -> "repair garage door opener".',
  '',
  'CEILINGS & FANS:',
  ' • water stain on ceiling -> "stain-block and paint ceiling" (note: the leak itself may need a separate item).',
  ' • popcorn ceiling damaged -> "repair ceiling texture".',
  ' • ceiling fan wobbling / broken / missing -> "replace ceiling fan".',
  '',
  'CLOSETS & DOORS:',
  ' • closet shelf / rod broken or missing -> "replace closet shelving" / "replace closet rod".',
  ' • bifold / sliding closet door off track or damaged -> "replace bifold door" / "repair sliding door".',
  '',
  'SAFETY / COMPLIANCE (always call these out when seen — they are turn-blocking):',
  ' • missing / dead smoke or CO detector -> "replace smoke detector" / "replace CO detector".',
  ' • non-GFCI outlet near water / tripped GFCI -> "replace GFCI outlet".',
  ' • loose / missing stair handrail or guardrail -> "repair handrail".',
  '',
  'MISC:',
  ' • fireplace damaged / dirty -> the specific fireplace item; keys / rekey the property -> "rekey locks".',
  ' • fence / gate broken (exterior) -> "repair fence" / "repair gate"; patio / deck board -> "replace deck board".',
  ' • strong odor / suspected mold -> "odor treatment" / "mold remediation" (flag, do not diagnose severity).',
  '',
  '=== SCOPE & QUANTITY RULES ===',
  ' • ONE suggest_line per distinct item. If the inspector lists several things in one breath, emit several calls.',
  ' • Match the line item to the ACTUAL issue named or seen — never to an adjacent/associated item. A cluttered vanity is NOT "clean the tub"; a stained ceiling is NOT "paint the walls".',
  ' • Do not infer beyond the stated/visible defect. "The outlet cover is missing" is ONE cover, not "rewire the room".',
  ' • Repeat-suppression: never re-emit anything in the already-suggested list or a near-duplicate of a pending item; use edit_line to amend a pending item instead.',
  ' • Confidence: use "high" only for an explicit call-out or unambiguous visible damage; "medium" for a reasonable read; "low" when guessing at the exact catalog item (still emit it for voice call-outs).',
  '',
  'CONSERVATIVE VISION REMINDER: on a SILENT tick most frames warrant ZERO items — walls, floors, and fixtures in normal condition are not work. Only surface clear, unambiguous visible damage. When in doubt on a silent tick, stay silent. Voice call-outs are the opposite: always act on them.',
  '',
  '=== edit_line EXAMPLES (amending a PENDING item by voice) ===',
  ' • "make it two walls" / "actually three" -> quantity on the referenced pending item.',
  ' • "whole room" / "do the whole room" on a wall-paint item -> scopeQuery "whole room paint".',
  ' • "whole house" / "mist match the whole house" -> scopeQuery "whole house mist match".',
  ' • "assign that to PPW" / "give it to Vendor 2" -> vendor set to the named vendor.',
  ' • "fifty percent tenant" / "bill half to the tenant" -> tenantPct 50; "all on the owner" -> tenantPct 0.',
  ' • "make that about 200 square feet" -> quantity 200 on a measured item.',
  ' • Always set targetId to the pending item being changed. If the phrase introduces a NEW item instead, use suggest_line, not edit_line.',
  '',
  '=== READING NUMBERS & UNITS ===',
  ' • Spoken counts map to quantity: "two", "a couple" -> 2; "three" -> 3; "a few"/"several" -> leave quantityStated=false and estimate.',
  ' • "a hundred square feet" / "about 150 feet" -> estimatedQuantity for measured items (quantityStated only if they clearly stated an exact figure).',
  ' • Never invent a precise measurement the inspector did not give — use estimatedQuantity and let them confirm.',
  '',
  '=== NAVIGATION & NOISE (do NOT create items) ===',
  ' • Movement/orientation commands are NOT work: "move to the kitchen", "go to the front", "let\'s head outside", "next room", "pan over here", "hold on", "okay", "let me look". Emit NO tool call for these.',
  ' • Filler and thinking-aloud ("um", "so", "this one here", "what else") -> no tool call.',
  ' • A room-change phrase ("now the primary bathroom") is handled elsewhere — do not turn it into a line item.',
  '',
  '=== TENANT BILL-BACK ===',
  ' • Default the tenant bill-back to the system default unless the inspector states a split.',
  ' • Damage beyond normal wear (holes, pet damage, broken fixtures) is typically tenant-billable; general make-ready (paint, clean, normal-wear carpet) typically is not — but only set a percent when the inspector says so.',
  '',
  '=== MEASURED SIZING ANCHORS (rough, for confirmation only) ===',
  ' • Walls: one bedroom wall ≈ 120-160 SF; one living-room wall ≈ 160-220 SF.',
  ' • Whole-room paint (walls+ceiling): small bedroom ≈ 400-500 SF; primary bedroom / living ≈ 600-900 SF.',
  ' • Carpet: bedroom ≈ 120-200 SF; living room ≈ 200-350 SF; stairs are priced PER STAIR (count the treads), not by area.',
  ' • Baseboard / trim: per room ≈ 40-60 LF. Countertop: kitchen run ≈ 15-25 LF; vanity ≈ 4-8 LF.',
  ' • Flooring (LVP/tile): bedroom ≈ 120-200 SF; kitchen ≈ 120-200 SF. Treat any of these as a draft the inspector adjusts.',
  '',
  '=== GOOD vs BAD BEHAVIOR ===',
  ' • GOOD: inspector says "the blind in here is snapped and the carpet is stained" -> TWO calls: "replace faux wood blind" + "replace carpet".',
  ' • GOOD: silent frame of a clean, undamaged bedroom -> NO calls.',
  ' • BAD: silent frame of a normal kitchen -> inventing "clean the oven" with no visible grime. Do not.',
  ' • BAD: "paint this wall" -> suggesting "paint whole room". Match the stated scope exactly.',
  ' • BAD: emitting prose ("I see a wall that needs paint"). Tool calls only — no text, ever.',
  '',
  '=== ADDITIONAL DEFECT PHRASINGS (voice synonyms → query) ===',
  ' • "beat up" / "banged up" / "dinged" / "scuffed up" a surface -> the repair or repaint for that surface.',
  ' • "shot" / "trashed" / "destroyed" / "gone" (e.g. "the carpet is shot") -> replace that item.',
  ' • "acting up" / "not working" / "won\'t turn on" -> repair or replace the named fixture/appliance.',
  ' • "filthy" / "nasty" / "grimy" / "gross" -> the appropriate clean for that surface/appliance.',
  ' • "loose" (rail, knob, toilet, fixture) -> "secure" or "replace" that item; "wobbly" -> same.',
  ' • "leaking" / "dripping" -> repair/replace the plumbing fixture at that location.',
  ' • "burnt" / "scorched" countertop or floor -> replace that surface.',
  ' • "peeling" paint / wallpaper -> "scrape and repaint" / "remove wallpaper".',
  ' • "missing" (cover, bulb, screen, hardware, detector) -> replace/install that item.',
  '',
  '=== COMMON MAKE-READY TURN SCOPE (typical, not mandatory) ===',
  ' • Interior repaint (walls, sometimes ceilings) where worn or marked.',
  ' • Whole-house clean at the appropriate level; carpet clean or replace by condition.',
  ' • Blind replacements for any damaged faux-wood blinds; light bulbs and detector batteries/units.',
  ' • Outlet/switch covers; minor drywall patching; hardware tighten/replace.',
  ' • Yard reset (mow, edge, trim, weed, mulch) for exterior/curb scope.',
  ' Use this only to recognize likely work when the inspector names or shows it — never to pad a room with unrequested items.',
  '',
  '=== TRADE / CATEGORY HINTS (for the category field — best guess; the catalog match is authoritative) ===',
  ' • Paint & drywall; Flooring (carpet / hard surface); Cleaning; Window coverings; Doors & hardware; Trim & carpentry.',
  ' • Plumbing; Electrical; Appliances; HVAC & mechanical; Cabinets & countertops; Bath fixtures.',
  ' • Exterior & landscaping; Pest control; Trash-out & debris; Safety & compliance.',
  ' If unsure of the category, still emit suggest_line with your best guess — the server re-resolves the exact code.',
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
      // Phrase aliases (e.g. "mismatch" → mist-match paint, "sales clean" →
      // whole-house sales clean) — the SAME normalization the voice AI uses.
      const alias = aliasFor(q);
      const match = await matchCatalog(alias ? alias.query : q, catalog, { sectionName, categoryHint: categoryHint || alias?.categoryHint });
      const top = match.candidates[0];
      const ok = match.confident || (fromVoice && top && match.topScore >= VOICE_FLOOR);
      if (!top || !ok) return null;
      // Shared guards (identical to the voice AI): a bare "blind" → faux-wood
      // blind; an explicit "level 1/2" clean → that exact tier.
      let item = correctBlinds(top.item, q, catalog);
      item = correctCleanLevel(item, q, catalog);
      const { unit, isMeasured } = measuredUnitOf(item);
      const isWholeHouse = wholeHouseExempt({ item, sectionName, utterance: q });
      const tenantPct = resolveTenantPct(item, tenantMonths);
      const measurementUnit = isMeasured && !isWholeHouse ? measurementWord(unit) : '';
      return { item, unit, isMeasured, isWholeHouse, tenantPct, measurementUnit, topScore: match.topScore, confident: match.confident };
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
      // Stairs (carpet/tread/runner) are priced PER STAIR though the unit reads
      // EACH, so a default of 1 mis-prices — treat like a measured item and have
      // the inspector confirm the stair count (parity with the voice AI).
      const stair = isStairCount(item);
      const needsMeasurement = ((isMeasured && !isWholeHouse) || stair) && !quantityStated;
      const measUnit = stair ? 'stairs' : measurementUnit;
      const quantity = quantityStated ? Number(inp.quantity) : (needsMeasurement ? null : 1);
      const rawEst = Number(inp.estimatedQuantity);
      const estimatedQuantity = (needsMeasurement && isFinite(rawEst) && rawEst > 0) ? Math.min(100000, Math.round(rawEst)) : null;
      return {
        id: `LIVE-${Date.now()}-${outIdx++}`,
        description: item.laborShortDescription,
        lineItemCode: item.lineItemCode,
        category: item.category,
        subcategory: item.subcategory,
        unit, quantity, needsMeasurement, measurementUnit: measUnit, estimatedQuantity,
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

      let usageIn = 0, usageOut = 0, usageCacheRead = 0, usageCacheCreate = 0;
      const pending: Promise<void>[] = [];
      const blocks: Record<number, { name: string; json: string }> = {};

      // ---- QUALITY-SAFE FAST PATH ----
      // Front-run a chip ONLY for a single, near-certain EA call-out so it
      // appears at Voyage speed instead of waiting on the model's first token.
      // This NEVER replaces the model: the full model run continues below and is
      // authoritative — it would resolve this same clear phrase to this same
      // high-confidence code (so it de-dupes by code), while everything else
      // (defect→repair translations, measured items needing an estimate, edits,
      // and any compound/ambiguous phrase) still waits for the model exactly as
      // before. Guards keep the false-positive risk at zero:
      //   • voice tick only, and a SINGLE phrase (no "and"/comma compounds)
      //   • no edit/amend language (those must go through the model)
      //   • the matcher reports `confident` AND clears an extra-high score floor
      //   • EA / count item only (measured items defer to the model's estimate)
      //   • code not already on screen (seenCodes already covers pending chips)
      const FAST_FLOOR = 0.62;
      const isSinglePhrase = !/\b(and|also|then|plus)\b|[,;]/i.test(transcriptDelta);
      const looksLikeEdit = /\b(make it|change it|change that|instead|assign|percent|that one|this one|actually|no\s)\b|%/i.test(transcriptDelta);
      if (hasVoice && isSinglePhrase && !looksLikeEdit) {
        pending.push((async () => {
          try {
            const r = await resolveItem(transcriptDelta, '', true);
            if (!r || !r.confident || (r.topScore ?? 0) < FAST_FLOOR) return;  // not near-certain → let the model decide
            if (r.isMeasured && !r.isWholeHouse) return;                        // measured → model provides the estimate
            const code = r.item.lineItemCode.toLowerCase();
            if (seenCodeSet.has(code)) return;                                  // already on screen / pending
            seenCodeSet.add(code);
            send('suggestion', buildSuggestionObj({ query: transcriptDelta, quantityStated: false, rationale: 'Heard call-out', confidence: 'high' }, r));
          } catch { /* fall through — the model run still covers it */ }
        })());
      }

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
              if (u) { usageIn += u.input_tokens || 0; usageCacheRead += u.cache_read_input_tokens || 0; usageCacheCreate += u.cache_creation_input_tokens || 0; usageOut += u.output_tokens || 0; }
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
      recordAiUsage({ source: 'room_scan_live', model: MODEL_FAST, inputTokens: usageIn, outputTokens: usageOut, cacheReadTokens: usageCacheRead, cacheCreationTokens: usageCacheCreate });
      send('done', {});
      res.end();
      return;
    }

    // ---------------- NON-STREAMING JSON PATH (fallback) ----------------
    const data = await resp.json();
    recordAiUsage({ source: 'room_scan_live', model: MODEL_FAST, inputTokens: data?.usage?.input_tokens, outputTokens: data?.usage?.output_tokens, cacheReadTokens: data?.usage?.cache_read_input_tokens, cacheCreationTokens: data?.usage?.cache_creation_input_tokens });
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
