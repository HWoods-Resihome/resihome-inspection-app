/**
 * lib/slackBotBrain.ts — the "answer" layer for the conversational Resiwalk bot.
 *
 * Phase 2a: natural-language INSPECTION + FINDING lookups. A question is parsed
 * into a structured intent by Claude (same fetch/model the app already uses),
 * then run against:
 *   - the inspection search layer (searchInspectionsPage) for counts / "last at
 *     <address>", and
 *   - the pre-aggregated Insights snapshot (readInsightsSnapshot) for item-level
 *     findings (grass-condition fails, overall pass/fail) — one cheap read, no
 *     per-inspection fan-out.
 * Answers are Slack Block Kit; property ADDRESSES are the clickable links to the
 * inspection. Pricing (Phase 2b) is recognized and politely deferred.
 *
 * Everything here is READ-ONLY and best-effort — it never throws to the caller.
 */
import { searchInspectionsPage, type InspectionQuery } from '@/lib/hubspot';
import { readInsightsSnapshot, type InsightsRow } from '@/lib/insightsSnapshot';
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
  text: string;
  blocks?: any[];
  supplements?: { text: string; blocks?: any[] }[];
}

interface InspectionIntent {
  mode?: 'count' | 'list' | 'last';
  inspector?: string | null;
  state?: string | null;
  city?: string | null;
  template?: string | null;
  address?: string | null;
  since_days?: number | null;
  month?: string | null;
}
interface FindingIntent {
  item?: 'grass' | 'overall';
  tone?: 'fail' | 'pass' | 'any';
  inspector?: string | null;
  state?: string | null;
  template?: string | null;
  since_days?: number | null;
  month?: string | null;
}
interface Intent {
  intent: 'inspection_lookup' | 'finding_lookup' | 'pricing_lookup' | 'clarify' | 'unsupported';
  clarify_question?: string;
  inspection?: InspectionIntent;
  finding?: FindingIntent;
}

// ---- Claude intent parse -----------------------------------------------------

const SYSTEM = `You route natural-language questions from Resihome staff in Slack to a structured intent. Respond with ONLY a JSON object, no prose, no code fence.

Intents:
- "inspection_lookup": counting/finding inspections by who/where/when. Fill "inspection": {
    mode: "count" | "list" | "last",
    inspector: person name or null, state: 2-letter US state code or null, city: string or null,
    template: "scope"|"1099"|"qc"|"community"|"vacancy"|"any",
    address: street address or null, since_days: integer or null, month: "this"|"last"|"YYYY-MM"|null }
  Examples: "last scope at <address>" -> mode:"last",template:"scope",address set.
  "how many did <name> complete this month" -> mode:"count",inspector set,month:"this".
  "how many completed in Florida this month" -> mode:"count",state:"FL",month:"this".
- "finding_lookup": questions about an ITEM/FINDING OUTCOME on inspections (pass/fail of a specific thing, or overall pass/fail). Fill "finding": {
    item: "grass" (lawn/grass condition) | "overall" (whole inspection pass/fail),
    tone: "fail" | "pass" | "any",
    inspector, state, template ("1099" for leasing-agent), since_days, month }
  Examples: "how many 1099 inspections failed grass in the last 2 weeks" -> item:"grass",tone:"fail",template:"1099",since_days:14.
  "how many inspections failed this month" -> item:"overall",tone:"fail",month:"this".
  NOTE: today only "grass" and "overall" findings are supported. For any OTHER specific item (mailbox, smoke detector, paint, etc.) use intent "unsupported".
- "pricing_lookup": rate-card pricing (repair/replace/install costs, labor/material, "how much to ...").
- "clarify": ambiguous — set "clarify_question" to a short follow-up.
- "unsupported": anything else (including item findings other than grass/overall).`;

async function parseIntent(question: string): Promise<Intent> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { intent: 'unsupported' };
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 500, temperature: 0, system: SYSTEM,
        messages: [{ role: 'user', content: question.slice(0, 1000) }],
      }),
    });
    const j = await resp.json().catch(() => ({} as any));
    const usage = j?.usage || {};
    recordAiUsage({ source: 'slack_bot', model: MODEL, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 });
    const text = Array.isArray(j?.content) ? j.content.map((c: any) => c?.text || '').join('') : '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { intent: 'clarify', clarify_question: 'Could you rephrase that? I can look up inspections, findings (grass/overall pass-fail), or rate-card pricing.' };
    return JSON.parse(m[0]) as Intent;
  } catch (e) {
    console.warn('[slack-bot] parseIntent failed:', e);
    return { intent: 'unsupported' };
  }
}

// ---- shared helpers ----------------------------------------------------------

function windowStart(w: { since_days?: number | null; month?: string | null }): Date | null {
  if (w.since_days && w.since_days > 0) return new Date(Date.now() - w.since_days * 86400000);
  const now = new Date();
  if (w.month === 'this') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (w.month === 'last') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const m = w.month && /^(\d{4})-(\d{2})$/.exec(w.month);
  if (m) return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1));
  return null;
}
function windowEnd(w: { month?: string | null }): Date | null {
  const now = new Date();
  if (w.month === 'this') return now;
  if (w.month === 'last') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const m = w.month && /^(\d{4})-(\d{2})$/.exec(w.month);
  if (m) return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10), 1));
  return null;
}
function whenPhrase(w: { since_days?: number | null; month?: string | null }): string {
  if (w.since_days) return ` in the last ${w.since_days} days`;
  if (w.month === 'this') return ' this month';
  if (w.month === 'last') return ' last month';
  if (w.month) return ` in ${w.month}`;
  return '';
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
function slackEsc(s: string): string { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
/** The property address rendered as the clickable link to its inspection. */
function addrLink(id: string, address: string): string {
  return `<${inspLink(id)}|${slackEsc(address || '(no address)')}>`;
}
function nameMatches(have: string | null | undefined, want: string | null | undefined): boolean {
  if (!want) return true;
  const w = want.trim().toLowerCase();
  const h = (have || '').toLowerCase();
  if (!h) return false;
  if (h.includes(w) || w.includes(h)) return true;
  const wt = w.split(/\s+/).filter(Boolean);
  return wt.length > 0 && wt.every((t) => h.includes(t));
}

// ---- inspection lookups (live search) ----------------------------------------

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

async function runInspectionLookup(insp: InspectionIntent): Promise<BotAnswer> {
  const templateType = insp.template && insp.template !== 'any' ? TEMPLATE_TYPE[insp.template] : '';
  const templates = templateType ? [templateType] : [];
  const start = windowStart(insp);
  const end = windowEnd(insp);
  const stateCode = (insp.state || '').trim().toUpperCase();

  if (insp.mode === 'last' || (insp.address && insp.mode !== 'count')) {
    const rows = await fetchCompleted({ search: insp.address || '', templates }, 2);
    const match = rows.find((r) => nameMatches(r.inspectorName, insp.inspector)) || rows[0];
    if (!match) {
      return { text: `I couldn't find a completed ${templateType ? TEMPLATE_LABEL[templateType] + ' ' : ''}inspection${insp.address ? ` at "${insp.address}"` : ''}.` };
    }
    const label = TEMPLATE_LABEL[match.templateType] || match.templateType;
    const lines = [
      `*${label}* — ${addrLink(match.recordId, match.propertyAddressSnapshot)}`,
      `• Completed: *${dateOnly(match.completedAt || match.pdfGeneratedAt || match.approvedAt)}*`,
      `• Inspector: ${match.inspectorName || '—'}`,
      ...(match.approvedByName ? [`• Approved by: ${match.approvedByName}${match.approvedAt ? ` (${dateOnly(match.approvedAt)})` : ''}`] : []),
      ...(match.totalClientCost != null ? [`• Rate-card total (client): *${money(match.totalClientCost)}*`] : []),
    ];
    const pdfs: string[] = [];
    if (match.pdfMasterUrl) pdfs.push(`<${match.pdfMasterUrl}|Master PDF>`);
    if (match.pdfChargebackUrl) pdfs.push(`<${match.pdfChargebackUrl}|Tenant Chargeback PDF>`);
    if (match.pdfUrl && !match.pdfMasterUrl) pdfs.push(`<${match.pdfUrl}|Report PDF>`);
    if (pdfs.length) lines.push(pdfs.join('   ·   '));
    return {
      text: `${label} at ${match.propertyAddressSnapshot} — completed ${dateOnly(match.completedAt)}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
    };
  }

  const inspectorSearch = insp.inspector && !insp.address ? insp.inspector : '';
  let rows = await fetchCompleted({ search: inspectorSearch, templates }, 5);
  if (insp.inspector) rows = rows.filter((r) => nameMatches(r.inspectorName, insp.inspector));
  if (stateCode) rows = rows.filter((r) => stateOfRegion(r.regionSnapshot) === stateCode);
  if (start) rows = rows.filter((r) => { const c = r.completedAt ? new Date(r.completedAt) : null; return c && c >= start && (!end || c < end); });

  const who = insp.inspector ? ` by *${insp.inspector}*` : '';
  const whereState = stateCode ? ` in *${stateCode}*` : '';
  const tpl = templateType ? ` ${TEMPLATE_LABEL[templateType]}` : '';
  const when = whenPhrase(insp);
  const headline = `*${rows.length}*${tpl} inspection${rows.length === 1 ? '' : 's'} completed${who}${whereState}${when}.`;
  const answer: BotAnswer = {
    text: `${rows.length} completed${who}${whereState}${when}`.replace(/\*/g, ''),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: headline } }],
  };
  if (rows.length > 0) answer.supplements = [listSupplement(rows, !insp.inspector)];
  return answer;
}

// ---- finding lookups (Insights snapshot) -------------------------------------

async function runFindingLookup(f: FindingIntent): Promise<BotAnswer> {
  const snap = await readInsightsSnapshot();
  if (!snap || !Array.isArray(snap.rows)) {
    return { text: 'I couldn’t load the analytics snapshot just now — please try again in a moment.' };
  }
  const item = f.item === 'overall' ? 'overall' : 'grass';
  const tone = f.tone || 'fail';
  const templateType = f.template && f.template !== 'any' ? TEMPLATE_TYPE[f.template] : '';
  const stateCode = (f.state || '').trim().toUpperCase();
  const start = windowStart(f);
  const end = windowEnd(f);
  const dateOf = (r: InsightsRow) => r.completedAt || r.scheduledDate || r.createdAt;

  let rows = snap.rows.slice();
  if (item === 'grass') {
    rows = rows.filter((r) => tone === 'pass' ? r.grassTone === 'good' : tone === 'any' ? !!r.grassTone : r.grassTone === 'fail');
  } else {
    rows = rows.filter((r) => tone === 'pass' ? r.inspectionResult === 'pass' : tone === 'any' ? !!r.inspectionResult : r.inspectionResult === 'fail');
  }
  if (templateType) rows = rows.filter((r) => r.templateType === templateType);
  if (stateCode) rows = rows.filter((r) => stateOfRegion(r.region) === stateCode);
  if (f.inspector) rows = rows.filter((r) => nameMatches(r.inspectorName, f.inspector));
  if (start) rows = rows.filter((r) => { const d = dateOf(r); const c = d ? new Date(d) : null; return c && c >= start && (!end || c < end); });

  // newest first
  rows.sort((a, b) => (dateOf(a) || '') < (dateOf(b) || '') ? 1 : -1);

  const toneWord = tone === 'pass' ? 'passed' : tone === 'any' ? 'had a recorded' : 'failed';
  const itemWord = item === 'grass' ? ' grass condition' : '';
  const who = f.inspector ? ` by *${f.inspector}*` : '';
  const whereState = stateCode ? ` in *${stateCode}*` : '';
  const tpl = templateType ? ` ${TEMPLATE_LABEL[templateType]}` : (item === 'grass' ? ' 1099' : '');
  const when = whenPhrase(f);
  const headline = item === 'grass'
    ? `*${rows.length}*${tpl} inspection${rows.length === 1 ? '' : 's'} ${toneWord}${itemWord}${who}${whereState}${when}.`
    : `*${rows.length}*${tpl} inspection${rows.length === 1 ? '' : 's'} ${toneWord} overall${who}${whereState}${when}.`;

  const answer: BotAnswer = {
    text: headline.replace(/\*/g, ''),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: headline } }],
  };
  if (rows.length > 0) {
    const CAP = 40;
    const items = rows.slice(0, CAP).map((r, i) =>
      `${i + 1}. ${addrLink(r.recordId, r.propertyAddress)} — ${dateOnly(dateOf(r))}${f.inspector ? '' : ` · ${r.inspectorName || r.inspectorEmail || '—'}`}${item === 'grass' && r.grassCondition ? ` · _${r.grassCondition}_` : ''}`);
    const extra = rows.length > CAP ? `\n_…and ${rows.length - CAP} more._` : '';
    answer.supplements = [{
      text: `${rows.length} inspections`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Addresses & dates:*\n${items.join('\n')}${extra}` } }],
    }];
  }
  return answer;
}

/** Shared itemized thread reply — addresses are the links. */
function listSupplement(rows: InspectionSummary[], showInspector: boolean): { text: string; blocks?: any[] } {
  const CAP = 40;
  const items = rows.slice(0, CAP).map((r, i) =>
    `${i + 1}. ${addrLink(r.recordId, r.propertyAddressSnapshot)} — ${dateOnly(r.completedAt)}${showInspector ? ` · ${r.inspectorName}` : ''}`);
  const extra = rows.length > CAP ? `\n_…and ${rows.length - CAP} more._` : '';
  return {
    text: `${rows.length} inspections`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*Addresses & completion dates:*\n${items.join('\n')}${extra}` } }],
  };
}

// ---- Public entry point ------------------------------------------------------

export async function answerQuestion(question: string): Promise<BotAnswer> {
  const intent = await parseIntent(question);

  if (intent.intent === 'pricing_lookup') {
    return { text: 'Rate-card pricing answers are rolling out in the next update — for now I can answer inspection lookups and findings (grass / overall pass-fail).' };
  }
  if (intent.intent === 'clarify') {
    return { text: intent.clarify_question || 'Could you clarify — which property, person, or region do you mean?' };
  }
  if (intent.intent === 'finding_lookup' && intent.finding) {
    try { return await runFindingLookup(intent.finding); }
    catch (e) { console.warn('[slack-bot] finding lookup failed:', e); return { text: 'Something went wrong pulling that up — please try again in a moment.' }; }
  }
  if (intent.intent === 'inspection_lookup' && intent.inspection) {
    try { return await runInspectionLookup(intent.inspection); }
    catch (e) { console.warn('[slack-bot] inspection lookup failed:', e); return { text: 'Something went wrong pulling that up — please try again in a moment.' }; }
  }
  return {
    text: 'I can look up inspections (“last scope at 123 Main St”, “how many did Carolina Falcon complete this month”, “how many completed in Florida this month”) and findings (“how many 1099 inspections failed grass in the last 2 weeks”, “how many failed overall this month”). Specific line-items beyond grass, and rate-card pricing, are coming next.',
  };
}
