/**
 * ResiWalk - Services — review-learning loop.
 *
 * The Services analog of the inspection AI-learning loop. It reads recently
 * REVIEWED service work orders — each carrying the AI's original concern (why it
 * routed to Review) and the human reviewer's decision (approve / modify / reject)
 * plus their note — and learns from the disagreements:
 *   • Reviewers consistently APPROVE despite a concern  → the AI was too strict;
 *     propose a refinement so it stops flagging that.
 *   • Reviewers REJECT / MODIFY                          → the concern was valid;
 *     reinforce it as a check.
 * The synthesized checks are merged into the Services AI checks as `source:'auto'`
 * (✨ AI-learned), which admins can adopt (edit) or delete.
 */
import { searchServiceWorkOrdersByStatus, upsertAutoServiceChecks, readServiceAiChecks, type AutoServiceCheckCandidate } from '@/lib/hubspot';
import { recordAiUsage } from '@/lib/aiUsage';
import { worktypeLabel, subtypeLabel, type Worktype } from './worktypes';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

interface ReviewSample {
  worktype: string;
  subtype: string;
  concern: string;   // ai_notes — why it went to review
  decision: string;  // approve | modify | reject
  note: string;      // review_notes — the reviewer's reason
}

/** Reviewed services (completed with a recorded review decision), newest first. */
async function readReviewSamples(limit = 120): Promise<ReviewSample[]> {
  const rows = await searchServiceWorkOrdersByStatus('completed', 200).catch(() => null);
  if (!rows) return [];
  const out: ReviewSample[] = [];
  for (const r of rows) {
    const p = r.props || {};
    const decision = String(p.review_decision || '').trim();
    if (!decision) continue; // only human-reviewed services teach us anything
    out.push({
      worktype: String(p.worktype || ''),
      subtype: String(p.subtype || ''),
      concern: String(p.ai_notes || '').trim().slice(0, 400),
      decision,
      note: String(p.review_notes || '').trim().slice(0, 400),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY is not set — review learning is unavailable.');
  return k;
}

/** Synthesize learned check candidates from reviewer decisions. */
export async function synthesizeServiceCheckCandidates(samples: ReviewSample[]): Promise<AutoServiceCheckCandidate[]> {
  if (samples.length < 3) return []; // need a little signal before generalizing
  const lines = samples.map((s, i) => {
    const scope = `${s.worktype ? worktypeLabel(s.worktype as Worktype) : 'Any'}${s.subtype ? ` · ${subtypeLabel(s.worktype as Worktype, s.subtype)}` : ''}`;
    return `${i + 1}. [${scope}] decision=${s.decision.toUpperCase()}${s.concern ? ` · AI concern: ${s.concern}` : ''}${s.note ? ` · reviewer: ${s.note}` : ''}`;
  }).join('\n');

  const system = 'You improve a Services AI review that decides whether a completed field service (photos + form answers) is CLEAN (auto-complete) or needs human REVIEW. You are given recently reviewed services: the AI\'s original concern and the human reviewer\'s decision + note. Learn from the disagreements. When reviewers consistently APPROVE despite a concern, the AI was too strict — write a check refinement so it stops flagging that pattern. When reviewers REJECT or MODIFY, reinforce the concern as a check. Only propose checks that recur across multiple services; be conservative and specific. Each check is one imperative, verifiable sentence.';

  const tool = {
    name: 'report_checks',
    description: 'Return the learned check candidates.',
    input_schema: {
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              signature: { type: 'string', description: 'stable kebab-case fingerprint of this learning, e.g. "approve-fast-duration"' },
              check: { type: 'string', description: 'one imperative, verifiable sentence' },
              worktype: { type: 'string', description: 'work type id to scope to, or empty for all' },
              subtype: { type: 'string', description: 'subtype id to scope to, or empty for all' },
              decision: { type: 'string', description: 'the dominant reviewer decision this came from' },
              samples: { type: 'number', description: 'how many services support this' },
            },
            required: ['signature', 'check'],
          },
        },
      },
      required: ['checks'],
    },
  };

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 900, system,
      tools: [tool], tool_choice: { type: 'tool', name: 'report_checks' },
      messages: [{ role: 'user', content: [{ type: 'text', text: `Recently reviewed services (${samples.length}):\n${lines}\n\nPropose up to 8 learned checks.` }] }],
    }),
  });
  if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`Learning call failed ${resp.status}: ${t.slice(0, 200)}`); }
  const data = await resp.json();
  try {
    const u = data?.usage;
    recordAiUsage({ source: 'service_ai_learning', model: MODEL, inputTokens: (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0), outputTokens: u?.output_tokens || 0 });
  } catch { /* noop */ }
  const block = (data?.content || []).find((c: any) => c.type === 'tool_use' && c.name === 'report_checks');
  const raw = Array.isArray(block?.input?.checks) ? block.input.checks : [];
  return raw
    .filter((c: any) => c && String(c.signature || '').trim() && String(c.check || '').trim())
    .slice(0, 8)
    .map((c: any) => ({
      signature: `learn:${String(c.signature).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
      check: String(c.check).trim(),
      worktype: String(c.worktype || ''),
      subtype: String(c.subtype || ''),
      meta: { samples: Number(c.samples) || undefined, decision: String(c.decision || '').trim() || undefined },
    }));
}

/** Read → synthesize → merge. Returns the merged checks + stats for the client. */
export async function refreshServiceChecksFromReviews(): Promise<{ checks: any[]; added: number; refreshed: number; samples: number; candidates: number }> {
  const samples = await readReviewSamples();
  const candidates = await synthesizeServiceCheckCandidates(samples);
  if (!candidates.length) return { checks: (await readServiceAiChecks()) || [], added: 0, refreshed: 0, samples: samples.length, candidates: 0 };
  const { checks, added, refreshed } = await upsertAutoServiceChecks(candidates);
  return { checks, added, refreshed, samples: samples.length, candidates: candidates.length };
}
