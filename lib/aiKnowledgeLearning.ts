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
import { put, list } from '@vercel/blob';
import { readAiFeedback, type AiFeedbackEvent } from '@/lib/aiFeedback';
import { upsertAutoKnowledgeEntries, type AutoKnowledgeCandidate } from '@/lib/hubspot';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';

// Decisions that mean the human accepted the suggested code vs. rejected it.
const ACCEPT = new Set(['approve', 'add', 'move', 'edit']); // edit on an 'add' keeps the code
const REJECT = new Set(['decline', 'remove', 'dismiss']);

const MIN_SAMPLES = 2;       // learn fast from sparse early usage (was 3)
const MAJORITY = 0.6;        // how lopsided accept/reject must be to be "consistent" (was 0.7)
const MAX_EXAMPLES = 3;      // example phrases shown per rule

function cleanPhrase(q?: string): string | null {
  const s = (q || '').replace(/\s+/g, ' ').trim();
  if (s.length < 3) return null;
  return s.slice(0, 60);
}

/**
 * The code-preference signal in one event, if any:
 *   - add (or untyped voice/scan add): accept → "prefer this code", reject → "avoid it".
 *   - remove: accepting the removal → "avoid" (the code shouldn't be there);
 *             declining the removal → "prefer/keep" (the line is legit).
 * edit / wrongRoom / needsPhoto / missingCategory adjust parameters or placement,
 * not the code choice, so they don't vote on code preference.
 */
function codeVote(e: AiFeedbackEvent): { code: string; vote: 'prefer' | 'avoid'; phrase: string | null } | null {
  const code = e.suggestion?.catalogCode;
  if (!code) return null;
  const accepted = ACCEPT.has(e.decision);
  const rejected = REJECT.has(e.decision);
  if (!accepted && !rejected) return null;
  const type = (e.suggestion?.type || '').toLowerCase();
  const phrase = cleanPhrase(e.suggestion?.query);
  if (!type || type === 'add') return { code, vote: accepted ? 'prefer' : 'avoid', phrase };
  if (type === 'remove') return { code, vote: accepted ? 'avoid' : 'prefer', phrase };
  return null;
}

interface CodeAgg {
  code: string;
  prefer: number;
  avoid: number;
  preferPhrases: Set<string>;
  avoidPhrases: Set<string>;
}

/** Build learned knowledge candidates from the last `days` of feedback. */
export async function synthesizeKnowledgeCandidates(days = 90): Promise<AutoKnowledgeCandidate[]> {
  const events = await readAiFeedback(days);
  return candidatesFromEvents(events);
}

/** Aggregate already-loaded feedback events into knowledge candidates. */
async function candidatesFromEvents(events: AiFeedbackEvent[]): Promise<AutoKnowledgeCandidate[]> {
  const byCode = new Map<string, CodeAgg>();

  for (const e of events) {
    const v = codeVote(e);
    if (!v) continue;
    const agg = byCode.get(v.code) || (byCode.set(v.code, { code: v.code, prefer: 0, avoid: 0, preferPhrases: new Set(), avoidPhrases: new Set() }), byCode.get(v.code)!);
    if (v.vote === 'prefer') { agg.prefer++; if (v.phrase) agg.preferPhrases.add(v.phrase); }
    else { agg.avoid++; if (v.phrase) agg.avoidPhrases.add(v.phrase); }
  }

  // Resolve code → description + category (best-effort; fall back to bare code).
  const descByCode = new Map<string, string>();
  const catByCode = new Map<string, string>();
  try {
    const catalog = await getCachedCatalog();
    for (const c of catalog) {
      descByCode.set(c.lineItemCode, c.laborShortDescription || c.laborFullDescription || c.lineItemCode);
      if (c.category) catByCode.set(c.lineItemCode, c.category);
    }
  } catch { /* no catalog → code-only text */ }

  const label = (code: string) => {
    const d = descByCode.get(code);
    return d && d !== code ? `“${d}” (${code})` : code;
  };
  const exampleList = (phrases: Set<string>) =>
    [...phrases].slice(0, MAX_EXAMPLES).map((p) => `“${p}”`).join(', ');

  const candidates: AutoKnowledgeCandidate[] = [];
  for (const agg of byCode.values()) {
    const total = agg.prefer + agg.avoid;
    if (total < MIN_SAMPLES) continue;

    if (agg.prefer / total >= MAJORITY) {
      const ex = exampleList(agg.preferPhrases);
      candidates.push({
        signature: `accept:${agg.code}`,
        text: `Inspectors consistently choose ${label(agg.code)}${ex ? ` when they say things like ${ex}` : ''}. Prefer it for similar call-outs.`,
        meta: { code: agg.code, accepts: agg.prefer, rejects: agg.avoid, samples: total, examples: [...agg.preferPhrases].slice(0, MAX_EXAMPLES) },
      });
    } else if (agg.avoid / total >= MAJORITY) {
      const ex = exampleList(agg.avoidPhrases);
      candidates.push({
        signature: `reject:${agg.code}`,
        text: `Inspectors consistently reject ${label(agg.code)}${ex ? ` for call-outs like ${ex}` : ''}. Don't suggest it there unless they ask.`,
        meta: { code: agg.code, accepts: agg.prefer, rejects: agg.avoid, samples: total, examples: [...agg.avoidPhrases].slice(0, MAX_EXAMPLES) },
      });
    }
    // else: ambiguous (no clear majority) — don't write a rule.
  }

  // ── Tenant % norms ─────────────────────────────────────────────────────────
  // When inspectors consistently set the SAME tenant responsibility % on lines of
  // a category (an edit correction), surface that as guidance — a real behavior /
  // depreciation signal beyond the scheduled defaults.
  const pctByCategory = new Map<string, number[]>();
  for (const e of events) {
    const pct = e.correction?.toTenantPct;
    const code = e.suggestion?.catalogCode;
    if (pct == null || !isFinite(pct) || pct < 0 || pct > 100 || !code) continue;
    const cat = catByCode.get(code);
    if (!cat) continue;
    const rounded = Math.round(pct / 5) * 5; // tenant % moves in steps of 5
    (pctByCategory.get(cat) || (pctByCategory.set(cat, []), pctByCategory.get(cat)!)).push(rounded);
  }
  for (const [cat, vals] of pctByCategory) {
    if (vals.length < MIN_SAMPLES) continue;
    const counts = new Map<number, number>();
    for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
    let mode = vals[0], modeN = 0;
    for (const [v, n] of counts) if (n > modeN) { mode = v; modeN = n; }
    if (modeN / vals.length < MAJORITY) continue; // no clear, consistent norm
    candidates.push({
      signature: `tenantpct:${cat.toLowerCase()}`,
      text: `Inspectors consistently set tenant responsibility to ${mode}% on ${cat} lines. Default to ${mode}% there unless the depreciation schedule or the inspector says otherwise.`,
      meta: { category: cat, tenantPct: mode, samples: vals.length, agree: modeN },
    });
  }

  // Strongest signals first (most samples) so the cap keeps the best rules.
  candidates.sort((a, b) => (Number(b.meta?.samples) || 0) - (Number(a.meta?.samples) || 0));
  return candidates;
}

/** Synthesize and persist learned knowledge into the AI Knowledge store. */
export async function refreshLearnedKnowledge(days = 90): Promise<{
  candidates: number; added: number; refreshed: number; skipped: number;
  feedbackEvents: number; codeJudgementEvents: number; newestEventTs: string | null;
}> {
  const events = await readAiFeedback(days);
  const candidates = await candidatesFromEvents(events);
  const result = await upsertAutoKnowledgeEntries(candidates);
  // Volume signals so "Learn now" makes clear whether feedback is still flowing
  // (newestEventTs) and how much of it is a usable signal — a frozen newestEventTs
  // means capture stopped; a growing event count with 0 new entries just means
  // the existing rules are getting stronger, not that nothing was learned.
  const newestEventTs = events.reduce<string | null>((m, e) => (e.ts && (!m || e.ts > m) ? e.ts : m), null);
  const codeJudgementEvents = events.filter((e) => codeVote(e) != null).length;
  const summary = { candidates: candidates.length, ...result, feedbackEvents: events.length, codeJudgementEvents, newestEventTs };
  console.log(`[ai-learning] knowledge refresh: ${JSON.stringify(summary)}`);
  return summary;
}

// ---------------------------------------------------------------------------
// Near-real-time learning: refresh on feedback ingestion (throttled), so new
// knowledge appears within minutes of the activity that produced it — not just
// on the nightly cron. Two-level throttle keeps it cheap: a per-instance timer
// short-circuits the hot path, and a shared Blob marker stops every serverless
// instance from refreshing in the same window. Idle = zero work.
// ---------------------------------------------------------------------------
const REALTIME_THROTTLE_MS = 3 * 60 * 1000;
const REFRESH_MARKER = 'ai-learning/last-knowledge-refresh.json';
let _lastRealtimeRefreshAt = 0;
// Per-instance identity used to claim the refresh window (see the lease below).
const _instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function readMarker(): Promise<{ at: number; owner: string }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { at: 0, owner: '' };
  try {
    const { blobs } = await list({ prefix: REFRESH_MARKER });
    const hit = blobs.find((b) => b.pathname === REFRESH_MARKER);
    if (!hit) return { at: 0, owner: '' };
    const d = await fetch(hit.url).then((r) => r.json()).catch(() => null);
    return { at: Number(d?.at) || 0, owner: String(d?.owner || '') };
  } catch { return { at: 0, owner: '' }; }
}
async function writeMarker(at: number, owner: string): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await put(REFRESH_MARKER, JSON.stringify({ at, owner }),
      { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
  } catch { /* best-effort */ }
}

/**
 * Refresh learned knowledge if it hasn't run in the last few minutes. Called
 * from feedback ingestion so the knowledge base self-updates in near real time.
 * Best-effort; never throws.
 *
 * Concurrency: under load, many serverless instances hit this in the same
 * window. A naive read-then-write marker still lets them all pass the throttle
 * check and refresh together — a thundering herd of read+merge+write against the
 * single admin knowledge record. Vercel Blob has no compare-and-swap, so we use
 * a LAST-WRITE-WINS LEASE: claim the window by writing our instance id, wait a
 * short jitter, then re-read — only the instance whose id survived proceeds. The
 * rest back off. Collapses N concurrent refreshes to ~1.
 */
export async function maybeRefreshLearnedKnowledge(): Promise<void> {
  const now = Date.now();
  if (now - _lastRealtimeRefreshAt < REALTIME_THROTTLE_MS) return; // per-instance fast path
  _lastRealtimeRefreshAt = now;
  try {
    const marker = await readMarker();
    if (now - marker.at < REALTIME_THROTTLE_MS) return; // refreshed recently — skip
    // Claim the window, then confirm we won (last write wins).
    await writeMarker(now, _instanceId);
    await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 500)));
    const confirm = await readMarker();
    if (confirm.owner && confirm.owner !== _instanceId) return; // another instance claimed it
    await refreshLearnedKnowledge(90);
  } catch (e: any) {
    console.warn('[ai-learning] realtime refresh failed:', String(e?.message || e).slice(0, 120));
  }
}

/**
 * Diagnostics for "why isn't the AI learning?": how much feedback exists, how
 * much of it is a usable code-judgement signal, how many distinct codes have
 * enough samples, and how many knowledge candidates that yields. Surfaced by
 * /api/admin/ai-learning so we can tell capture problems (0 events) apart from
 * threshold problems (events but no candidates).
 */
export async function learningDiagnostics(days = 90): Promise<{
  days: number;
  feedbackEvents: number;
  newestEventTs: string | null;
  byDay: Record<string, number>;
  bySource: Record<string, number>;
  byDecision: Record<string, number>;
  codeJudgementEvents: number;
  distinctCodes: number;
  codesWithEnoughSamples: number;
  candidates: number;
  minSamples: number;
}> {
  const events = await readAiFeedback(days);
  const bySource: Record<string, number> = {};
  const byDecision: Record<string, number> = {};
  const byDay: Record<string, number> = {};   // capture activity per calendar day
  const perCode = new Map<string, number>();
  let codeJudgementEvents = 0;
  let newestEventTs: string | null = null;
  for (const e of events) {
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    byDecision[e.decision] = (byDecision[e.decision] || 0) + 1;
    if (e.ts) {
      byDay[e.ts.slice(0, 10)] = (byDay[e.ts.slice(0, 10)] || 0) + 1;
      if (!newestEventTs || e.ts > newestEventTs) newestEventTs = e.ts;
    }
    const v = codeVote(e);
    if (v) {
      codeJudgementEvents++;
      perCode.set(v.code, (perCode.get(v.code) || 0) + 1);
    }
  }
  const candidates = await synthesizeKnowledgeCandidates(days);
  return {
    days,
    feedbackEvents: events.length,
    newestEventTs,
    byDay,
    bySource,
    byDecision,
    codeJudgementEvents,
    distinctCodes: perCode.size,
    codesWithEnoughSamples: [...perCode.values()].filter((n) => n >= MIN_SAMPLES).length,
    candidates: candidates.length,
    minSamples: MIN_SAMPLES,
  };
}
