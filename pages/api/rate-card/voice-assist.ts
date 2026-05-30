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
const MAX_TOOL_ROUNDS = 4; // safety cap on tool loops per turn

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

function systemPrompt(section: string, location: string, linesDesc: string): string {
  const loc = location || section;
  return [
    `You help a property inspector manage Scope rate-card line items by voice for the "${loc}" area of a home. Speed matters — keep the inspector moving.`,
    ``,
    `Defaults (apply silently unless the inspector says otherwise):`,
    `  - Vendor: "Vendor 1".  - Tenant chargeback: 100%.`,
    `Never ask about vendor or tenant percent. Only use a different value if the inspector states one (e.g. "assign to PPW", "50 percent tenant").`,
    ``,
    `ADDING a line:`,
    `1. Use search_catalog to find the line item matching what they described.`,
    `2. Only ask a clarifying question if genuinely ambiguous (e.g. which of two distinct items). One short question, then proceed.`,
    `3. You need a quantity. If they stated it, use it; if not, ask once, naming the unit (e.g. "How many linear feet?").`,
    `4. When you have a code and quantity, call propose_line. The inspector's spoken "yes" within this chat IS their confirmation — the app saves automatically when you call propose_line. Do NOT claim a line was added in your own words; the app announces the save.`,
    ``,
    `EDITING an existing line (e.g. "make that 50% tenant", "change the paint line to PPW", "that should be 3 not 1"):`,
    `  - Identify which existing line they mean (the most recent one if they say "that"/"the last one", or by description). Use the id from the list below.`,
    `  - Call edit_line with that externalId and only the fields to change. The app saves and announces it.`,
    ``,
    `${linesDesc}`,
    ``,
    `When you call propose_line or edit_line, do not write any sentence at all — no "I'll find...", no "Added..." — the app shows and speaks the confirmation prompt itself. Only produce text when you genuinely need to ask the inspector a question. Keep questions very short and spoken-friendly. Never invent a code; only use codes from search_catalog.`,
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
    vendorCostStr = ` — vendor ${money(calc.vendorCost)}`;
  } catch { /* if calc fails, omit the cost rather than block the line */ }
  return `${item.laborShortDescription} — ${qty} ${item.laborMeas || 'EA'}, ${vendor}, ${pct}% tenant${vendorCostStr}`;
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
    const system = systemPrompt(body.section || '', body.location || '', describeLines(byCode, currentLines));

    let usedSearchThisTurn = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const model = round === 0 || usedSearchThisTurn ? MODEL_SMART : MODEL_FAST;

      // Stream this model call; forward text deltas live to the client.
      const { content } = await streamAnthropic(
        { model, max_tokens: 1024, system, tools: tools(), messages },
        (chunk) => sse(res, 'delta', { text: chunk })
      );

      const toolUses = content.filter((c) => c.type === 'tool_use');
      const textBlocks = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

      // No tool calls -> the assistant asked a question / replied. The text has
      // already streamed via 'delta'; send the final marker so the client knows
      // to (a) finalize the message and (b) auto-restart the mic.
      if (toolUses.length === 0) {
        sse(res, 'question', { text: textBlocks || 'Could you tell me more?', awaitingReply: true });
        sse(res, 'done', {});
        return res.end();
      }

      usedSearchThisTurn = false;
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
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(compact) });
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
            section: body.section || '',
            location: body.location || '',
            lineItemCode: code,
            quantity: qty,
            tenantBillBackPercent: pct,
            assignedTo: vendor,
            note: tu.input?.note ? String(tu.input.note) : '',
            photoUrls: [],
          };
          // A line was matched. Any preamble text already streamed via 'delta';
          // the client auto-saves and announces it.
          sse(res, 'proposal', {
            action: 'add',
            line,
            summary: lineToSummary(item, qty, vendor, pct, region, regions),
            assistantText: textBlocks || undefined,
            awaitingReply: false,
          });
          sse(res, 'done', {});
          return res.end();
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
            summary: item ? lineToSummary(item, qty, vendor, pct, region, regions) : `${existing.lineItemCode} — ${qty}, ${vendor}, ${pct}% tenant`,
            assistantText: textBlocks || undefined,
            awaitingReply: false,
          });
          sse(res, 'done', {});
          return res.end();
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
