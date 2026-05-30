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
import { matchCatalog } from '@/lib/voiceCatalogMatch';
import { VENDORS } from '@/lib/vendors';
import type { RateCardLineItem, RateCardLineInput } from '@/lib/types';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// Two-model split: the smart model is used when the agent must reason about
// catalog matching (a turn that calls search_catalog); the fast model handles
// simple clarify turns (e.g. "how many linear feet?"). This keeps the common,
// chatty turns snappy without sacrificing match quality.
const MODEL_SMART = 'claude-opus-4-8';
const MODEL_FAST = 'claude-haiku-4-5-20251001';
const MAX_TOOL_ROUNDS = 4; // safety cap on tool loops per turn

interface ClientMessage { role: 'user' | 'assistant'; content: string; }
interface BodyShape {
  messages: ClientMessage[];
  section: string;
  location: string;
  region: string;
}

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY is not set — voice assistant is unavailable.');
  return k;
}

function systemPrompt(section: string, location: string): string {
  const loc = location || section;
  return [
    `You help a property inspector add Scope rate-card line items by voice for the "${loc}" area of a home. Speed matters — keep the inspector moving.`,
    `Your job: turn what the inspector says into ONE rate-card line item at a time, with as few questions as possible.`,
    ``,
    `Defaults (use these silently unless the inspector says otherwise):`,
    `  - Vendor: "Vendor 1".`,
    `  - Tenant chargeback: 100%.`,
    `Do NOT ask about vendor or tenant percent. Only use a different value if the inspector explicitly states one (e.g. "assign to PPW", "50 percent tenant").`,
    ``,
    `Steps:`,
    `1. Use search_catalog to find the line item that best matches what they described.`,
    `2. If the top candidate clearly matches, go with it. Only ask a clarifying question if genuinely ambiguous between distinct options (e.g. repair vs replace) — one short question, then proceed.`,
    `3. You need a quantity (a number in the item's unit of measure). If the inspector already stated it ("120 feet"), use it. If not, ask ONE short question naming the unit, e.g. "How many linear feet?".`,
    `4. As soon as you have the line item code and a quantity, call propose_line — applying the Vendor 1 / 100% defaults (or any values the inspector gave).`,
    ``,
    `Keep replies very short and spoken-friendly — one question, no lists, no preamble. Never invent a line item code; only use codes returned by search_catalog.`,
  ].join('\n');
}

function tools() {
  return [
    {
      name: 'search_catalog',
      description: 'Semantic search of the rate-card catalog for the line item that best matches what the inspector described. Returns the top candidate line items with their code, description, category, and unit of measure.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the inspector wants done, e.g. "gutter cleaning" or "replace broken window screen".' },
          categoryHint: { type: 'string', description: 'Optional category guess to bias results, e.g. "Gutters".' },
        },
        required: ['query'],
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
      description: 'Propose a complete line item to add, once you have the code and quantity. Vendor and tenant percent are optional — they default to "Vendor 1" and 100% unless the inspector stated otherwise. This shows the inspector a draft to confirm — it does not save.',
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
  ];
}

function lineToSummary(item: RateCardLineItem, qty: number, vendor: string, pct: number): string {
  return `${item.laborShortDescription} — ${qty} ${item.laborMeas || 'EA'}, ${vendor}, ${pct}% tenant`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body as BodyShape;
    const clientMessages = Array.isArray(body?.messages) ? body.messages : [];
    if (clientMessages.length === 0) return res.status(400).json({ error: 'No messages' });

    const catalog = await fetchRateCardCatalog();
    const byCode = new Map(catalog.map((c) => [c.lineItemCode, c]));

    // Build the Anthropic message list from the client transcript.
    const messages: any[] = clientMessages.map((m) => ({ role: m.role, content: m.content }));

    const system = systemPrompt(body.section || '', body.location || '');

    // Model selection: use the smart model while the agent is still reasoning
    // about which catalog item to pick (the first round, and any round right
    // after a search where it interprets candidates). Once matching is settled,
    // simple clarify turns use the fast model. We bias toward smart on round 0
    // (the match decision) and switch to fast only for follow-up clarify rounds
    // that didn't involve a fresh search.
    let usedSearchThisTurn = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Round 0 is the match decision -> smart. Later rounds: smart if we just
      // searched (interpreting candidates), fast otherwise (plain clarify).
      const model = round === 0 || usedSearchThisTurn ? MODEL_SMART : MODEL_FAST;
      const resp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system,
          tools: tools(),
          messages,
        }),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return res.status(502).json({ error: `Assistant call failed ${resp.status}: ${t.slice(0, 200)}` });
      }
      const data = await resp.json();
      const content: any[] = data.content || [];

      const toolUses = content.filter((c) => c.type === 'tool_use');
      const textBlocks = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

      // No tool calls -> the assistant is asking a question / replying.
      // awaitingReply=true tells the client to auto-restart the mic (the AI
      // asked something and is waiting on the inspector).
      if (toolUses.length === 0) {
        return res.status(200).json({
          type: 'question',
          text: textBlocks || 'Could you tell me more?',
          awaitingReply: true,
        });
      }

      // Reset per-round; set below if a search runs this round.
      usedSearchThisTurn = false;

      // Append the assistant turn (with tool_use) to history, then resolve tools.
      messages.push({ role: 'assistant', content });
      const toolResults: any[] = [];

      for (const tu of toolUses) {
        if (tu.name === 'search_catalog') {
          usedSearchThisTurn = true;
          const q = String(tu.input?.query || '');
          const hint = tu.input?.categoryHint ? String(tu.input.categoryHint) : undefined;
          const matches = await matchCatalog(q, catalog, { topK: 10, categoryHint: hint });
          const compact = matches.map((m) => ({
            code: m.item.lineItemCode,
            description: m.item.laborShortDescription,
            category: m.item.category,
            subcategory: m.item.subcategory,
            unit: m.item.laborMeas,
          }));
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(compact),
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
          // Apply the streamlined defaults: Vendor 1 / 100% tenant unless the
          // inspector stated otherwise. Validate + clamp against real constraints.
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

          // Build the RateCardLineInput. externalId is a fresh client-style key;
          // the save endpoint upserts by it (same pattern as a manual add).
          const externalId = `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const line: RateCardLineInput = {
            externalId,
            section: body.section || '',
            location: body.location || '',
            lineItemCode: code,
            quantity: qty,
            tenantBillBackPercent: pct,
            assignedTo: vendor,
            note: tu.input?.note ? String(tu.input.note) : '',
            photoUrls: [],
          };
          // Return the proposal for the client to show as a draft + confirm.
          // awaitingReply=false: a line was matched, not a question — the mic
          // should NOT auto-restart (inspector confirms, then chooses to continue).
          return res.status(200).json({
            type: 'proposal',
            line,
            summary: lineToSummary(item, qty, vendor, pct),
            assistantText: textBlocks || undefined,
            awaitingReply: false,
          });
        } else {
          toolResults.push({
            type: 'tool_result', tool_use_id: tu.id, is_error: true,
            content: JSON.stringify({ error: `Unknown tool ${tu.name}` }),
          });
        }
      }

      // Feed tool results back and loop for the next assistant turn.
      messages.push({ role: 'user', content: toolResults });
    }

    // Exhausted tool rounds without a proposal/question — bail gracefully.
    return res.status(200).json({
      type: 'message',
      text: "I couldn't pin that down. Try rephrasing what's needed, or add it manually.",
    });
  } catch (e: any) {
    console.error('POST /api/rate-card/voice-assist failed:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
