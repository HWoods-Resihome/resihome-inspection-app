/**
 * lib/slackBotBrain.ts — the "answer" layer for the conversational Resiwalk bot.
 *
 * Phase 2a: natural-language INSPECTION lookups. A question is parsed into a
 * structured intent by Claude (same fetch/model the app already uses), then run
 * against the existing inspection search layer (searchInspectionsPage) and
 * formatted as Slack Block Kit. Pricing (Phase 2b) is recognized and politely
 * deferred so the router is already complete.
 *
 * Everything here is READ-ONLY and best-effort — it never throws to the caller
 * (the Slack worker); on any failure it returns a friendly message.
 */
import { searchInspectionsPage, type InspectionQuery } from '@/lib/hubspot';
import type { InspectionSummary } from '@/lib/types';
import { stateOfRegion } from '@/lib/userAccess';
import { recordAiUsage } from '@/lib/aiUsage';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const APP_BASE = (process.env.APP_BASE_URL || 'https://resiwalk.com').replace(/\/$/, '');

const TEMPLATE_TYPE: Record<string, string> = {
  scope: 'pm_scope_rate_card',
  '1099': 'leasing_agent_1099_property_inspection',
  qc: 'pm_turn_reinspect_qc',
  community: 'pm_community_inspection',
  vacancy: 'pm_vacancy_occupancy_check',
};
const TEMPLATE_LABEL: Record<string, string> = {
  pm_scope_rate_card: 'Scope Rate Card',
  leasing_agent_1099_property_inspection: '1099 Leasing Agent',
  pm_turn_reinspect_qc: 'Turn Re-Inspect QC',
  pm_community_inspection: 'Community / Visit',
  pm_vacancy_occupancy_check: 'Vacancy / Occupancy',
};

export interface BotAnswer {
  text: string;          // fallback/notification text
  blocks?: any[];        // primary card
  supplements?: { text: string; blocks?: any[] }[]; // extra thread replies (detail)
}

interface InspectionIntent {
  mode?: 'count' | 'list' | 'last';
  inspector?: string | null;
  state?: string | null;   // "FL", "GA", …
  city?: string | null;
  template?: string | null; // scope|1099|qc|community|vacancy|any
  address?: string | null;
  since_days?: number | null;
  month?: string | null;    // "this" | "last" | "YYYY-MM"
}
interface Intent {
  intent: 'inspection_lookup' | 'pricing_lookup' | 'clarify' | 'unsupported';
  clarify_question?: string;
  inspection?: InspectionIntent;
}

// ---- Claude intent parse -----------------------------------------------------

const SYSTEM = `You route natural-language questions from Resihome staff in Slack to a structured intent. Respond with ONLY a JSON object, no prose, no code fence.

Intents:
- "inspection_lookup": counting/finding inspections. Fill "inspection": {
    mode: "count" | "list" | "last",
    inspector: person name or null,
    state: 2-letter US state code (FL, GA, TN, TX, NC, …) or null,
    city: city name or null,
    template: one of "scope","1099","qc","community","vacancy","any",
    address: street address or null,
    since_days: integer (e.g. 30) or null,
    month: "this" | "last" | "YYYY-MM" | null
  }
  Guidance: "last scope at <address>" -> mode:"last", template:"scope", address set.
  "how many did <name> complete this month" -> mode:"count", inspector set, month:"this".
  "how many completed in Florida this month" -> mode:"count", state:"FL", month:"this".
  "this month" -> month:"this"; "last 30 days" -> since_days:30.
- "pricing_lookup": rate-card pricing questions (repair/replace/install costs, labor/material, "how much to ...").
- "clarify": ambiguous — set "clarify_question" to a short follow-up (e.g. only a state given for pricing: ask which city).
- "unsupported": anything else.

Return e.g. {"intent":"inspection_lookup","inspection":{"mode":"count","inspector":"Carolina Falcon","month":"this","template":"any"}}`;

async function parseIntent(question: string): Promise<Intent> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { intent: 'unsupported' };
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: 'user', content: question.slice(0, 1000) }],
      }),
    });
    const j = await resp.json().catch(() => ({} as any));
    const usage = j?.usage || {};
    recordAiUsage({ source: 'slack_bot', model: MODEL, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 });
    const text = Array.isArray(j?.content) ? j.content.map((c: any) => c?.text || '').join('') : '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { intent: 'clarify', clarify_question: 'Could you rephrase that? I can look up inspections or rate-card pricing.' };
    return JSON.parse(m[0]) as Intent;
  } catch (e) {
    console.warn('[slack-bot] parseIntent failed:', e);
    return { intent: 'unsupported' };
  }
}

// ---- Inspection queries ------------------------------------------------------

function windowStart(insp: InspectionIntent): Date | null {
  if (insp.since_days && insp.since_days > 0) return new Date(Date.now() - insp.since_days * 86400000);
  const now = new Date();
  if (insp.month === 'this') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (insp.month === 'last') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const m = insp.month && /^(\d{4})-(\d{2})$/.exec(insp.month);
  if (m) return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1));
  return null;
}
function windowEnd(insp: InspectionIntent): Date | null {
  const now = new Date();
  if (insp.month === 'this') return now;
  if (insp.month === 'last') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const m = insp.month && /^(\d{4})-(\d{2})$/.exec(insp.month);
  if (m) return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10), 1));
  return null; // since_days / none → no upper bound
}

function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
const inspLink = (id: string) => `${APP_BASE}/inspection/${id}`;

/** Fetch completed inspections matching the base filters, paging up to a cap. */
async function fetchCompleted(base: Partial<InspectionQuery>, maxPages = 5): Promise<InspectionSummary[]> {
  const out: InspectionSummary[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, total } = await searchInspectionsPage({
      search: base.search || '', status: 'completed',
      inspectors: base.inspectors || [], templates: base.templates || [], regions: base.regions || [],
      externalEmail: null, externalViewRegions: undefined,
      sortField: 'date', sortDir: 'desc', page, pageSize: 100,
    } as any);
    out.push(...items);
    if (out.length >= total || items.length < 100) break;
  }
  return out;
}

function matchesInspector(row: InspectionSummary, name: string | null | undefined): boolean {
  if (!name) return true;
  const want = name.trim().toLowerCase();
  const have = (row.inspectorName || '').toLowerCase();
  if (have.includes(want) || want.includes(have)) return true;
  // token overlap (first/last name in any order)
  const wt = want.split(/\s+/).filter(Boolean);
  return wt.length > 0 && wt.every((t) => have.includes(t));
}

async function runInspectionLookup(insp: InspectionIntent): Promise<BotAnswer> {
  const templateType = insp.template && insp.template !== 'any' ? TEMPLATE_TYPE[insp.template] : '';
  const templates = templateType ? [templateType] : [];
  const start = windowStart(insp);
  const end = windowEnd(insp);
  const stateCode = (insp.state || '').trim().toUpperCase();

  // "last" — a single most-recent completed inspection at an address.
  if (insp.mode === 'last' || (insp.address && insp.mode !== 'count')) {
    const rows = await fetchCompleted({ search: insp.address || '', templates }, 2);
    const match = rows.find((r) => matchesInspector(r, insp.inspector)) || rows[0];
    if (!match) {
      return { text: `I couldn't find a completed ${insp.template && insp.template !== 'any' ? TEMPLATE_LABEL[templateType] + ' ' : ''}inspection${insp.address ? ` at "${insp.address}"` : ''}.` };
    }
    const label = TEMPLATE_LABEL[match.templateType] || match.templateType;
    const lines = [
      `*${label}* — ${match.propertyAddressSnapshot}`,
      `• Completed: *${dateOnly(match.completedAt || match.pdfGeneratedAt || match.approvedAt)}*`,
      `• Inspector: ${match.inspectorName || '—'}`,
      ...(match.approvedByName ? [`• Approved by: ${match.approvedByName}${match.approvedAt ? ` (${dateOnly(match.approvedAt)})` : ''}`] : []),
      ...(match.totalClientCost != null ? [`• Rate-card total (client): *${money(match.totalClientCost)}*`] : []),
    ];
    const links: string[] = [`<${inspLink(match.recordId)}|Open inspection>`];
    if (match.pdfMasterUrl) links.push(`<${match.pdfMasterUrl}|Master PDF>`);
    if (match.pdfChargebackUrl) links.push(`<${match.pdfChargebackUrl}|Tenant Chargeback PDF>`);
    if (match.pdfUrl && !match.pdfMasterUrl) links.push(`<${match.pdfUrl}|Report PDF>`);
    lines.push(links.join('   ·   '));
    return {
      text: `${label} at ${match.propertyAddressSnapshot} — completed ${dateOnly(match.completedAt)}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
    };
  }

  // "count" / "list" — filtered set within a date window.
  const inspectorSearch = insp.inspector && !insp.address ? insp.inspector : '';
  let rows = await fetchCompleted({ search: inspectorSearch, templates }, 5);
  if (insp.inspector) rows = rows.filter((r) => matchesInspector(r, insp.inspector));
  if (stateCode) rows = rows.filter((r) => stateOfRegion(r.regionSnapshot) === stateCode);
  if (start) rows = rows.filter((r) => { const c = r.completedAt ? new Date(r.completedAt) : null; return c && c >= start && (!end || c < end); });

  const who = insp.inspector ? ` by *${insp.inspector}*` : '';
  const whereState = stateCode ? ` in *${stateCode}*` : '';
  const tpl = templateType ? ` ${TEMPLATE_LABEL[templateType]}` : '';
  const when = insp.since_days ? ` in the last ${insp.since_days} days`
    : insp.month === 'this' ? ' this month'
    : insp.month === 'last' ? ' last month'
    : insp.month ? ` in ${insp.month}` : '';

  const headline = `*${rows.length}*${tpl} inspection${rows.length === 1 ? '' : 's'} completed${who}${whereState}${when}.`;
  const answer: BotAnswer = {
    text: `${rows.length} completed${who}${whereState}${when}`.replace(/\*/g, ''),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: headline } }],
  };

  // Supplemental thread reply: itemized addresses + completion dates (capped).
  if (rows.length > 0) {
    const CAP = 40;
    const items = rows.slice(0, CAP).map((r, i) =>
      `${i + 1}. ${r.propertyAddressSnapshot} — ${dateOnly(r.completedAt)}${insp.inspector ? '' : ` · ${r.inspectorName}`} · <${inspLink(r.recordId)}|open>`);
    const extra = rows.length > CAP ? `\n_…and ${rows.length - CAP} more._` : '';
    answer.supplements = [{
      text: `${rows.length} inspections`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Addresses & completion dates:*\n${items.join('\n')}${extra}` } }],
    }];
  }
  return answer;
}

// ---- Public entry point ------------------------------------------------------

export async function answerQuestion(question: string): Promise<BotAnswer> {
  const intent = await parseIntent(question);

  if (intent.intent === 'pricing_lookup') {
    return { text: 'Rate-card pricing answers are rolling out in the next update — for now I can answer inspection lookups (e.g. “last scope at <address>”, “how many did <name> complete this month”).' };
  }
  if (intent.intent === 'clarify') {
    return { text: intent.clarify_question || 'Could you clarify — which property, person, or region do you mean?' };
  }
  if (intent.intent === 'inspection_lookup' && intent.inspection) {
    try {
      return await runInspectionLookup(intent.inspection);
    } catch (e) {
      console.warn('[slack-bot] inspection lookup failed:', e);
      return { text: 'Something went wrong pulling that up — please try again in a moment.' };
    }
  }
  return {
    text: 'I can look up inspections (e.g. “when was the last scope at 123 Main St”, “how many inspections did Carolina Falcon complete this month”, “how many completed in Florida this month”). Rate-card pricing is coming next.',
  };
}
