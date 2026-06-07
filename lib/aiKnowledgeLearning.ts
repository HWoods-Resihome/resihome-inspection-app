/**
 * Self-learning → AI Knowledge.
 *
 * Turns the captured human feedback (lib/aiFeedback) into human-READABLE
 * knowledge entries stored in the SAME AI Knowledge base inspectors and admins
 * already use (lib/hubspot AiKnowledgeEntry). Instead of an opaque model, the
 * AI's learning shows up as plain-English guidance like:
 *
 *   "Inspectors consistently choose 'Faux Wood Blind — replace' (FWB101) when
 *    they say things like 'broken blind', 'blinds missing'. Prefer it."
 *
 * which (a) feeds the AI prompt exactly like a human-authored rule, and (b) is
 * fully reviewable: admins can read it, edit it (adopting it), or delete it
 * (dismissing it) at /ai-knowledge. The loop refreshes these on a schedule
 * (daily cron) and never touches human or adopted entries.
 */
import { readAiFeedback, type AiFeedbackEvent } from '@/lib/aiFeedback';
import { upsertAutoKnowledgeEntries, type AutoKnowledgeCandidate } from '@/lib/hubspot';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';

// Decisions that mean the human accepted the suggested code vs. rejected it.
const ACCEPT = new Set(['approve', 'add', 'move', 'edit']); // edit on an 'add' keeps the code
const REJECT = new Set(['decline', 'remove', 'dismiss']);

const MIN_SAMPLES = 3;       // need enough signal before we write a rule
const MAJORITY = 0.7;        // how lopsided accept/reject must be to be "consistent"
const MAX_EXAMPLES = 3;      // example phrases shown per rule

function cleanPhrase(q?: string): string | null {
  const s = (q || '').replace(/\s+/g, ' ').trim();
  if (s.length < 3) return null;
  return s.slice(0, 60);
}

/** Only events where the CODE itself is what's being judged carry a useful signal. */
function isCodeJudgement(e: AiFeedbackEvent): boolean {
  const code = e.suggestion?.catalogCode;
  if (!code) return false;
  const t = e.suggestion?.type;
  return !t || t === 'add'; // voice/scan adds, and ai_review 'add' suggestions
}

interface CodeAgg {
  code: string;
  accepts: number;
  rejects: number;
  acceptPhrases: Set<string>;
  rejectPhrases: Set<string>;
}

/** Build learned knowledge candidates from the last `days` of feedback. */
export async function synthesizeKnowledgeCandidates(days = 90): Promise<AutoKnowledgeCandidate[]> {
  const events = await readAiFeedback(days);
  const byCode = new Map<string, CodeAgg>();

  for (const e of events) {
    if (!isCodeJudgement(e)) continue;
    const code = e.suggestion!.catalogCode as string;
    const agg = byCode.get(code) || (byCode.set(code, { code, accepts: 0, rejects: 0, acceptPhrases: new Set(), rejectPhrases: new Set() }), byCode.get(code)!);
    const phrase = cleanPhrase(e.suggestion?.query);
    if (ACCEPT.has(e.decision)) { agg.accepts++; if (phrase) agg.acceptPhrases.add(phrase); }
    else if (REJECT.has(e.decision)) { agg.rejects++; if (phrase) agg.rejectPhrases.add(phrase); }
  }

  // Resolve code → description (best-effort; fall back to the bare code).
  const descByCode = new Map<string, string>();
  try {
    const catalog = await getCachedCatalog();
    for (const c of catalog) descByCode.set(c.lineItemCode, c.laborShortDescription || c.laborFullDescription || c.lineItemCode);
  } catch { /* no catalog → code-only text */ }

  const label = (code: string) => {
    const d = descByCode.get(code);
    return d && d !== code ? `“${d}” (${code})` : code;
  };
  const exampleList = (phrases: Set<string>) =>
    [...phrases].slice(0, MAX_EXAMPLES).map((p) => `“${p}”`).join(', ');

  const candidates: AutoKnowledgeCandidate[] = [];
  for (const agg of byCode.values()) {
    const total = agg.accepts + agg.rejects;
    if (total < MIN_SAMPLES) continue;

    if (agg.accepts / total >= MAJORITY) {
      const ex = exampleList(agg.acceptPhrases);
      candidates.push({
        signature: `accept:${agg.code}`,
        text: `Inspectors consistently choose ${label(agg.code)}${ex ? ` when they say things like ${ex}` : ''}. Prefer it for similar call-outs.`,
        meta: { code: agg.code, accepts: agg.accepts, rejects: agg.rejects, samples: total, examples: [...agg.acceptPhrases].slice(0, MAX_EXAMPLES) },
      });
    } else if (agg.rejects / total >= MAJORITY) {
      const ex = exampleList(agg.rejectPhrases);
      candidates.push({
        signature: `reject:${agg.code}`,
        text: `Inspectors consistently reject ${label(agg.code)}${ex ? ` for call-outs like ${ex}` : ''}. Don't suggest it there unless they ask.`,
        meta: { code: agg.code, accepts: agg.accepts, rejects: agg.rejects, samples: total, examples: [...agg.rejectPhrases].slice(0, MAX_EXAMPLES) },
      });
    }
    // else: ambiguous (no clear majority) — don't write a rule.
  }

  // Strongest signals first (most samples) so the cap keeps the best rules.
  candidates.sort((a, b) => (Number(b.meta?.samples) || 0) - (Number(a.meta?.samples) || 0));
  return candidates;
}

/** Synthesize and persist learned knowledge into the AI Knowledge store. */
export async function refreshLearnedKnowledge(days = 90): Promise<{ candidates: number; added: number; refreshed: number; skipped: number }> {
  const candidates = await synthesizeKnowledgeCandidates(days);
  const result = await upsertAutoKnowledgeEntries(candidates);
  console.log(`[ai-learning] knowledge refresh: ${JSON.stringify({ candidates: candidates.length, ...result })}`);
  return { candidates: candidates.length, ...result };
}
