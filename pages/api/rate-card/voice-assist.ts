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
const MODEL = 'claude-opus-4-8';
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
    `You help a property inspector add Scope rate-card line items by voice for the "${loc}" area of a home.`,
    `Your job: turn what the inspector says into ONE rate-card line item at a time.`,
    ``,
    `Steps:`,
    `1. Use search_catalog to find the most appropriate catalog line item for what they described.`,
    `2. If several plausibly match, ask ONE short clarifying question to pick the right one.`,
    `3. Before proposing, you MUST have: the line item code, a quantity (a number), the assigned vendor, and the tenant chargeback percent.`,
    `   - Ask for any missing field, ONE question at a time, in plain language.`,
    `   - The quantity unit is the catalog item's unit of measure (EA, LF, SF, HR). Mention the unit when you ask (e.g. "How many linear feet?").`,
    `   - Vendor MUST be one of: ${VENDORS.join(', ')}. If unclear, ask; suggest "Internal Resolution" as the common default.`,
    `   - Tenant chargeback percent is 0-100 in steps of 5. If the inspector doesn't say, ask.`,
    `4. When you have all fields, call propose_line with them. Do not guess values you weren't given.`,
    ``,
    `Keep replies short and spoken-friendly — one question or one confirmation, no lists.`,
    `Never invent a line item code; only use codes returned by search_catalog.`,
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
      description: 'Propose a complete line item to add, once you have the code, quantity, vendor, and tenant percent. This shows the inspector a draft to confirm — it does not save.',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Catalog line item code (from search_catalog).' },
          quantity: { type: 'number', description: 'Quantity in the item\'s unit of measure.' },
          vendor: { type: 'string', description: `Assigned vendor; one of: ${VENDORS.join(', ')}.` },
          tenantBillBackPercent: { type: 'number', description: 'Tenant chargeback percent, 0-100 in steps of 5.' },
          note: { type: 'string', description: 'Optional short note for the line.' },
        },
        required: ['code', 'quantity', 'vendor', 'tenantBillBackPercent'],
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

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
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
      if (toolUses.length === 0) {
        return res.status(200).json({ type: 'question', text: textBlocks || 'Could you tell me more?' });
      }

      // Append the assistant turn (with tool_use) to history, then resolve tools.
      messages.push({ role: 'assistant', content });
      const toolResults: any[] = [];

      for (const tu of toolUses) {
        if (tu.name === 'search_catalog') {
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
          // Validate + clamp the agent's values against our real constraints.
          const qty = Number(tu.input?.quantity);
          let vendor = String(tu.input?.vendor || '');
          if (!VENDORS.includes(vendor)) vendor = VENDORS[0];
          let pct = Number(tu.input?.tenantBillBackPercent);
          if (!isFinite(pct)) pct = 0;
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
          return res.status(200).json({
            type: 'proposal',
            line,
            summary: lineToSummary(item, qty, vendor, pct),
            assistantText: textBlocks || undefined,
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
