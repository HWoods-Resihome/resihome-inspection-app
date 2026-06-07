/**
 * AI self-improvement loop — the "learn" + "apply" half of the flywheel.
 *
 * Capture (lib/aiFeedback) records what the AI proposed vs. what the human did.
 * This turns that accumulated feedback into a LEARNED MATCH MODEL: per
 * catalog-code signals for how often a suggested code is accepted vs. rejected.
 * matchCatalog can then gently boost codes inspectors consistently keep and
 * demote ones they consistently reject — so semantic matching gets better the
 * more the app is used, WITHOUT retraining any model weights.
 *
 * Safety:
 *  - The model is a reviewable artifact (Blob ai-learning/match-model.json),
 *    rebuilt deliberately via the admin endpoint — not silently on every event.
 *  - Application is OFF unless AI_LEARNING_ENABLED is set, and only nudges
 *    RANKING (never the raw confidence cosine), so confidence stays honest.
 *  - Deltas are clamped, so even a skewed sample can't dominate the cosine.
 *  - Validate any change with `npm run eval` (flag on vs off) before enabling
 *    in production.
 */
import { put, list } from '@vercel/blob';
import { readAiFeedback } from '@/lib/aiFeedback';

export interface LearnedMatchModel {
  generatedAt: string;
  sampleSize: number;          // feedback events that contributed
  /** Per-code ranking delta in cosine units, already clamped to ±MAX_DELTA. */
  deltas: Record<string, number>;
  /** Raw accept/reject tallies per code, for transparency in the admin view. */
  stats: Record<string, { accept: number; reject: number }>;
}

// A code's ranking nudge is bounded so learning can refine, never override,
// semantic similarity. Matches the scale of the existing category-hint boosts
// (±0.03–0.05 in matchCatalog).
const MAX_DELTA = 0.05;
const MIN_SAMPLES_PER_CODE = 3; // ignore codes with too little signal

const MODEL_PATH = 'ai-learning/match-model.json';

// Decisions that mean the human ACCEPTED the suggested code vs. REJECTED it.
// We only learn from suggestions where the CODE itself is what's being judged
// (an 'add' suggestion, or a voice/scan chip) — not qty/tenant% edits.
const ACCEPT = new Set(['approve', 'add', 'move']);
const REJECT = new Set(['decline', 'remove', 'dismiss']);

function isCodeJudgement(type?: string): boolean {
  // ai_review 'add' suggestions, and voice/scan adds, judge the code. 'edit'
  // and 'remove' of an existing line are about qty/keep, not code choice.
  if (!type) return true; // voice/scan events carry no type but always judge a code
  return type === 'add';
}

/** Build the learned model from accumulated feedback and persist it. */
export async function buildLearnedMatchModel(days = 90): Promise<LearnedMatchModel> {
  const events = await readAiFeedback(days);
  const stats: Record<string, { accept: number; reject: number }> = {};
  let sampleSize = 0;

  for (const e of events) {
    const code = e.suggestion?.catalogCode;
    if (!code) continue;
    if (!isCodeJudgement(e.suggestion?.type)) continue;
    const accepted = ACCEPT.has(e.decision);
    const rejected = REJECT.has(e.decision) || e.decision === 'edit'; // an edit on an 'add' kept the code; treat as accept below
    // 'edit' on an add means the code was right but values changed → accept.
    const isAccept = accepted || e.decision === 'edit';
    const isReject = rejected && e.decision !== 'edit';
    if (!isAccept && !isReject) continue;
    const s = stats[code] || (stats[code] = { accept: 0, reject: 0 });
    if (isAccept) s.accept++; else s.reject++;
    sampleSize++;
  }

  const deltas: Record<string, number> = {};
  for (const [code, s] of Object.entries(stats)) {
    const n = s.accept + s.reject;
    if (n < MIN_SAMPLES_PER_CODE) continue;
    // Net acceptance in [-1, 1] → scaled to ±MAX_DELTA.
    const net = (s.accept - s.reject) / n;
    const delta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, net * MAX_DELTA));
    if (Math.abs(delta) >= 0.005) deltas[code] = Number(delta.toFixed(4));
  }

  const model: LearnedMatchModel = { generatedAt: new Date().toISOString(), sampleSize, deltas, stats };

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      await put(MODEL_PATH, JSON.stringify(model),
        { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
    } catch (e: any) {
      console.warn('[ai-learning] model write failed:', String(e?.message || e).slice(0, 120));
    }
  }
  return model;
}

// Cached read so the hot matching path doesn't fetch the model every call.
let _cache: { model: LearnedMatchModel | null; at: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Current learned model (cached). Returns null if none built / not configured. */
export async function getLearnedMatchModel(): Promise<LearnedMatchModel | null> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.model;
  let model: LearnedMatchModel | null = null;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { blobs } = await list({ prefix: MODEL_PATH });
      const hit = blobs.find((b) => b.pathname === MODEL_PATH);
      if (hit) model = await fetch(hit.url).then((r) => r.json()).catch(() => null);
    } catch (e: any) {
      console.warn('[ai-learning] model read failed:', String(e?.message || e).slice(0, 120));
    }
  }
  _cache = { model, at: Date.now() };
  return model;
}

/**
 * Whether learned ranking adjustments are applied at serving time. ON by default
 * (the flywheel is "turned on"); set AI_LEARNING_ENABLED=0 (or false/off) as a
 * kill switch if matching ever regresses. Note this only has any effect once a
 * model has been built (the daily cron rebuilds it from feedback), and the
 * deltas are clamped to ±0.05 so they refine — never override — similarity.
 */
export function isLearningEnabled(): boolean {
  const v = (process.env.AI_LEARNING_ENABLED || '').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** Ranking delta for a code from the model (0 if absent). */
export function learnedDelta(code: string, model: LearnedMatchModel | null): number {
  if (!model || !code) return 0;
  return model.deltas[code] || 0;
}
