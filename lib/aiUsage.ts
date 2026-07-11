/**
 * AI usage + cost tracking.
 *
 * Every AI call records {source, model, tokens} here. We do two things:
 *   1. Emit a structured `[ai-usage]` log line — the durable, scalable source of
 *      truth (queryable in Vercel logs / a log drain), never lost.
 *   2. Best-effort persist a running daily total to a Vercel Blob so the
 *      /admin/ai-usage dashboard can show recent spend without a database.
 *
 * Persistence is race-free WITHOUT a DB: each server instance overwrites its OWN
 * blob (ai-usage/<date>/<instanceId>.json) with its running daily total; the
 * dashboard lists + sums all instance blobs for a day. Writes are throttled so a
 * high-frequency caller (the live camera) can't storm the blob store. Cold
 * instances reclaimed before a flush lose only their small tail — fine for an
 * estimate dashboard (the logs remain authoritative).
 */
import { put, list, del } from '@vercel/blob';

export type AiUsageSource =
  | 'ai_review' | 'room_scan_live' | 'room_scan' | 'voice_assist' | 'transcribe' | 'embeddings'
  | 'slack_bot' | 'service_ai_review';

// Estimated $ per 1M tokens (input / output). Update if pricing changes — these
// drive the dashboard's cost estimate only. Whisper is priced per minute.
const RATES: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-opus-4-8': { in: 15, out: 75 },
  'voyage': { in: 0.02, out: 0 },        // voyage-3-lite embeddings (input-only)
  'whisper': { in: 0, out: 0 },          // priced per-minute; see estimateWhisperCost
};

export function estimateCostUSD(model: string, inputTokens: number, outputTokens: number): number {
  const r = RATES[model] || RATES[Object.keys(RATES).find((k) => model.startsWith(k.split('-').slice(0, 2).join('-'))) || ''] || { in: 0, out: 0 };
  return (inputTokens / 1e6) * r.in + (outputTokens / 1e6) * r.out;
}

/** Whisper transcription: ~$0.006 / minute of audio. */
export function estimateWhisperCostUSD(seconds: number): number {
  return (Math.max(0, seconds) / 60) * 0.006;
}

/**
 * Per-minute cost for the speech-to-text model in use. whisper-1 ≈ $0.006/min;
 * gpt-4o-mini-transcribe ≈ $0.003/min; gpt-4o-transcribe ≈ $0.006/min. The newer
 * models return no `duration`, so callers pass an estimated clip length.
 */
export function estimateTranscribeCostUSD(model: string, seconds: number): number {
  const perMin = /mini-transcribe/.test(model) ? 0.003 : 0.006;
  return (Math.max(0, seconds) / 60) * perMin;
}

// ---- per-instance running daily aggregate ----
type Bucket = { calls: number; inputTokens: number; outputTokens: number; costUSD: number };
const INSTANCE_ID = Math.random().toString(36).slice(2, 10);
let dayKey = '';
let agg: Record<string, Bucket> = {};   // key: `${source}|${model}`
let lastFlush = 0;
const FLUSH_THROTTLE_MS = 20_000;

function today(): string { return new Date().toISOString().slice(0, 10); }

export function recordAiUsage(args: {
  source: AiUsageSource; model: string; inputTokens?: number; outputTokens?: number; costUSD?: number;
}): void {
  const inputTokens = args.inputTokens || 0;
  const outputTokens = args.outputTokens || 0;
  const costUSD = args.costUSD != null ? args.costUSD : estimateCostUSD(args.model, inputTokens, outputTokens);

  // 1) Structured log — authoritative, never lost.
  try { console.log(`[ai-usage] ${JSON.stringify({ source: args.source, model: args.model, inputTokens, outputTokens, costUSD: Math.round(costUSD * 1e6) / 1e6 })}`); } catch { /* noop */ }

  // 2) Roll into the per-instance daily aggregate.
  const d = today();
  if (d !== dayKey) { dayKey = d; agg = {}; lastFlush = 0; }
  const key = `${args.source}|${args.model}`;
  const b = agg[key] || (agg[key] = { calls: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 });
  b.calls++; b.inputTokens += inputTokens; b.outputTokens += outputTokens; b.costUSD += costUSD;

  // 3) Throttled, fire-and-forget flush to this instance's daily blob.
  const now = Date.now();
  if (now - lastFlush >= FLUSH_THROTTLE_MS) { lastFlush = now; void flush(); }
}

async function flush(): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return; // blob not configured → logs only
  try {
    await put(`ai-usage/${dayKey}/${INSTANCE_ID}.json`,
      JSON.stringify({ date: dayKey, instanceId: INSTANCE_ID, updatedAt: new Date().toISOString(), buckets: agg }),
      { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
  } catch (e: any) { console.warn('[ai-usage] flush failed:', String(e?.message || e).slice(0, 120)); }
}

/** Aggregate usage across all instance blobs for the last `days` days. */
export async function readAiUsage(days = 7): Promise<{
  byDay: Record<string, Bucket>;
  bySource: Record<string, Bucket>;
  byModel: Record<string, Bucket>;
  total: Bucket;
}> {
  const add = (t: Bucket, b: Bucket) => { t.calls += b.calls; t.inputTokens += b.inputTokens; t.outputTokens += b.outputTokens; t.costUSD += b.costUSD; };
  const empty = (): Bucket => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 });
  const byDay: Record<string, Bucket> = {}, bySource: Record<string, Bucket> = {}, byModel: Record<string, Bucket> = {};
  const total = empty();

  const wanted = new Set<string>();
  for (let i = 0; i < days; i++) wanted.add(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));

  if (!process.env.BLOB_READ_WRITE_TOKEN) return { byDay, bySource, byModel, total };
  try {
    // List ONLY the requested days' partitions (ai-usage/<date>/…), in parallel,
    // instead of scanning the entire ai-usage/ history and filtering client-side.
    // This keeps the dashboard O(days) rather than O(all-history-ever).
    const perDay = await Promise.all(Array.from(wanted).map(async (date) => {
      const urls: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: `ai-usage/${date}/`, cursor, limit: 1000 });
        for (const b of page.blobs) urls.push(b.url);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      const datas = await Promise.all(urls.map((u) => fetch(u).then((r) => r.json()).catch(() => null)));
      return { date, datas };
    }));
    for (const { date, datas } of perDay) {
      for (const data of datas) {
        if (!data?.buckets) continue;
        for (const [key, b] of Object.entries(data.buckets as Record<string, Bucket>)) {
          const [source, model] = key.split('|');
          add(byDay[date] || (byDay[date] = empty()), b);
          add(bySource[source] || (bySource[source] = empty()), b);
          add(byModel[model] || (byModel[model] = empty()), b);
          add(total, b);
        }
      }
    }
  } catch (e: any) { console.warn('[ai-usage] read failed:', String(e?.message || e).slice(0, 120)); }
  return { byDay, bySource, byModel, total };
}

/**
 * Delete ai-usage rollup blobs older than `retentionDays`. These accumulate one
 * blob per instance per day forever; pruning keeps storage bounded AND keeps
 * readAiUsage's list() fast as months pass. Date lives in the pathname
 * (ai-usage/<YYYY-MM-DD>/<instance>.json), and YYYY-MM-DD sorts chronologically
 * as a string, so the cutoff compare is a plain string comparison. Best-effort.
 */
export async function pruneOldAiUsage(retentionDays = 90): Promise<{ deleted: number; scanned: number }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { deleted: 0, scanned: 0 };
  const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 864e5).toISOString().slice(0, 10);
  let deleted = 0, scanned = 0;
  try {
    // Pruning must see the whole prefix to find old partitions, but page through
    // it with the cursor so a backlog beyond one list() page (1000) is fully
    // reclaimed rather than silently leaving a growing tail.
    const stale: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: 'ai-usage/', cursor, limit: 1000 });
      for (const b of page.blobs) {
        scanned++;
        const date = b.pathname.split('/')[1] || '';
        if (date && date < cutoff) stale.push(b.url);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < stale.length; i += 100) {
      await del(stale.slice(i, i + 100)); // del takes a url or an array of urls
      deleted += stale.slice(i, i + 100).length;
    }
  } catch (e: any) {
    console.warn('[ai-usage] prune failed:', String(e?.message || e).slice(0, 120));
  }
  return { deleted, scanned };
}
