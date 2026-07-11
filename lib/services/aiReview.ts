/**
 * ResiWalk - Services — Phase 5 AI review job.
 *
 * When a vendor submits a service it sits in "submitted" (the AI Processing tag).
 * This job reads each submitted order's evidence — completion-form answers +
 * before/after (and pet-station) photos — and evaluates it against the service AI
 * knowledge base (checks scoped by worktype+subtype). It returns a verdict:
 *   clean       → auto-move to Completed (+ completed_at, ontime vs due date)
 *   needs_review → move to Review for a human
 * and writes ai_verdict / ai_notes. Manual dry-run/apply admin endpoint first
 * (no unattended cron until validated). Analog of the inspection AI review.
 */
import sharp from 'sharp';
import { searchServiceWorkOrdersByStatus, patchServiceWorkOrder, readServiceAiChecks } from '@/lib/hubspot';
import { recordAiUsage } from '@/lib/aiUsage';
import { SAMPLE_AI_CHECKS, type AiCheck } from './aiKnowledge';
import { worktypeLabel, subtypeLabel, type Worktype } from './worktypes';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_PHOTOS = 8;
const PHOTO_EDGE = 512;

const splitUrls = (v: any): string[] =>
  String(v || '').split(/[\n,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s.split('#')[0]));

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY is not set — service AI review is unavailable.');
  return k;
}

async function fetchPhotoBlock(url: string): Promise<any | null> {
  try {
    const clean = url.split('#')[0];
    const r = await fetch(clean);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const jpeg = await sharp(buf).rotate().resize(PHOTO_EDGE, PHOTO_EDGE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 62 }).toBuffer();
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
  } catch { return null; }
}

// Active checks that apply to this worktype+subtype (empty worktype = all;
// empty subtype = all subtypes of that worktype), from the given check set.
function checksFor(all: AiCheck[], worktype: string, subtype: string): string[] {
  return all
    .filter((c) => c.active)
    .filter((c) => !c.worktype || c.worktype === worktype)
    .filter((c) => !c.subtype || c.subtype === subtype)
    .map((c) => c.check);
}

export interface ServiceVerdict { verdict: 'clean' | 'needs_review'; notes: string; issues: string[]; }

/** Run the AI review for one submitted order's evidence, against the given check set. */
export async function reviewOne(order: { id: string; props: Record<string, any> }, allChecks: AiCheck[] = SAMPLE_AI_CHECKS): Promise<ServiceVerdict> {
  const p = order.props;
  const worktype = (p.worktype || '') as Worktype;
  const subtype = p.subtype || '';
  const checks = checksFor(allChecks, worktype, subtype);
  const answers = (() => { try { return JSON.parse(p.answers_json || '{}'); } catch { return {}; } })();

  const beforeUrls = splitUrls(p.before_photo_urls);
  const afterUrls = splitUrls(p.after_photo_urls);
  const petBefore = splitUrls(p.pet_before_photo_urls);
  const petAfter = splitUrls(p.pet_after_photo_urls);

  // Photo budget, labelled by group so the model knows before vs after.
  const labelled: { label: string; url: string }[] = [];
  const add = (label: string, urls: string[]) => urls.forEach((url) => labelled.push({ label, url }));
  add('BEFORE', beforeUrls); add('AFTER', afterUrls); add('PET BEFORE', petBefore); add('PET AFTER', petAfter);
  const picks = labelled.slice(0, MAX_PHOTOS);
  const blocks = await Promise.all(picks.map((x) => fetchPhotoBlock(x.url)));
  const photoContent: any[] = [];
  for (let i = 0; i < picks.length; i++) {
    if (!blocks[i]) continue;
    photoContent.push({ type: 'text', text: `${picks[i].label} photo:` });
    photoContent.push(blocks[i]);
  }

  const system =
    `You are the ResiHome field-services QC reviewer. A vendor submitted a completed service; ` +
    `decide if the evidence is CLEAN (auto-approve) or NEEDS REVIEW (route to a human). Evaluate ONLY against the checks below — ` +
    `every check matters equally. Judge from the visible evidence and the vendor's answers. If a check depends on metadata you cannot ` +
    `see (exact photo timestamps, GPS), do not fail solely for that — note it, and only flag it when the visible evidence looks suspicious ` +
    `(e.g. before/after clearly identical, wrong property, work not actually done). Be fair but protect quality.\n\n` +
    `Service: ${worktypeLabel(worktype)} · ${subtypeLabel(worktype, subtype)}\n` +
    `CHECKS:\n${checks.length ? checks.map((c, i) => `${i + 1}. ${c}`).join('\n') : '(no specific checks — assess general completeness and that before/after evidence supports the work)'}`;

  const summary =
    `Answers submitted by the vendor:\n${Object.keys(answers).length ? JSON.stringify(answers, null, 2) : '(none)'}\n\n` +
    `Photo counts — before: ${beforeUrls.length}, after: ${afterUrls.length}` +
    (petBefore.length || petAfter.length ? `, pet before: ${petBefore.length}, pet after: ${petAfter.length}` : '') +
    `.\n${photoContent.length ? 'Photos follow.' : 'No usable photos were available — that itself is a concern for most services.'}\n\n` +
    `Return your decision via the report_verdict tool.`;

  const tool = {
    name: 'report_verdict',
    description: 'Report the QC decision for this submitted service.',
    input_schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['clean', 'needs_review'], description: 'clean = auto-approve to Completed; needs_review = route to a human.' },
        notes: { type: 'string', description: 'One or two plain sentences explaining the decision for the coordinator.' },
        issues: { type: 'array', items: { type: 'string' }, description: 'Short bullet list of specific concerns (empty when clean).' },
      },
      required: ['verdict', 'notes'],
    },
  };

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 700,
      system,
      tools: [tool], tool_choice: { type: 'tool', name: 'report_verdict' },
      messages: [{ role: 'user', content: [{ type: 'text', text: summary }, ...photoContent] }],
    }),
  });
  if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`AI review call failed ${resp.status}: ${t.slice(0, 200)}`); }
  const data = await resp.json();
  try {
    const u = data?.usage;
    recordAiUsage({ source: 'service_ai_review', model: MODEL, inputTokens: (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0), outputTokens: u?.output_tokens || 0 });
  } catch { /* noop */ }
  const block = (data?.content || []).find((c: any) => c.type === 'tool_use' && c.name === 'report_verdict');
  const input = block?.input || {};
  const verdict: ServiceVerdict = {
    verdict: input.verdict === 'clean' ? 'clean' : 'needs_review',
    notes: String(input.notes || '').slice(0, 900),
    issues: Array.isArray(input.issues) ? input.issues.map((s: any) => String(s)).slice(0, 12) : [],
  };
  return verdict;
}

export interface ReviewResult {
  mode: 'dry-run' | 'apply';
  configured: boolean;
  reviewed: number;
  completed: number;
  routedToReview: number;
  errors: number;
  items: { id: string; service: string; verdict: string; notes: string; issues: string[]; action: string; error?: string }[];
}

/**
 * Review submitted services. `id` optional to review a single order. Dry-run
 * returns the verdicts without writing; apply writes ai_verdict/ai_notes and moves
 * clean → completed (with completed_at + ontime), needs_review → review.
 */
export async function runServiceAiReview(apply: boolean, todayISO: string, onlyId?: string): Promise<ReviewResult | null> {
  const submitted = await searchServiceWorkOrdersByStatus('submitted', 200);
  if (submitted === null) return null; // not configured
  const orders = onlyId ? submitted.filter((o) => o.id === onlyId) : submitted;
  // Live, admin-edited checks (persisted) drive the review; fall back to seeds.
  const savedChecks = await readServiceAiChecks().catch(() => null);
  const allChecks: AiCheck[] = savedChecks && savedChecks.length ? (savedChecks as AiCheck[]) : SAMPLE_AI_CHECKS;

  const result: ReviewResult = { mode: apply ? 'apply' : 'dry-run', configured: true, reviewed: 0, completed: 0, routedToReview: 0, errors: 0, items: [] };
  for (const order of orders) {
    const service = String(order.props.address_snapshot || order.props.service_name || order.id);
    try {
      const v = await reviewOne(order, allChecks);
      result.reviewed++;
      const clean = v.verdict === 'clean';
      if (clean) result.completed++; else result.routedToReview++;

      if (apply) {
        const notes = [v.notes, ...(v.issues.length ? ['Issues:', ...v.issues.map((i) => `• ${i}`)] : [])].join('\n');
        const props: Record<string, any> = {
          ai_verdict: clean ? 'clean' : 'needs_review',
          ai_notes: notes.slice(0, 2000),
          status: clean ? 'completed' : 'review',
        };
        if (clean) {
          props.completed_at = new Date().toISOString();
          const due = String(order.props.due_date || '').slice(0, 10);
          if (due) props.ontime = todayISO <= due ? 'true' : 'false';
        }
        await patchServiceWorkOrder(order.id, props);
      }
      result.items.push({ id: order.id, service, verdict: v.verdict, notes: v.notes, issues: v.issues, action: apply ? (clean ? 'completed' : 'review') : (clean ? 'would-complete' : 'would-review') });
    } catch (e: any) {
      result.errors++;
      result.items.push({ id: order.id, service, verdict: 'error', notes: '', issues: [], action: 'error', error: String(e?.message || e).slice(0, 300) });
    }
  }
  return result;
}
