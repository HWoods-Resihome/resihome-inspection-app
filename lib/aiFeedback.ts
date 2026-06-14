/**
 * AI feedback capture — the self-improvement flywheel's data layer.
 *
 * Every time a human accepts, declines, edits, or overrides an AI suggestion we
 * record the pair {what the AI proposed → what the human actually did}. Those
 * pairs are the training signal for the loop: they feed few-shot "good example"
 * injection, catalog-match threshold tuning, and the eval gold set — so the more
 * the app is used, the better the AI gets, WITHOUT retraining model weights.
 *
 * Storage mirrors the proven ai-usage pattern (no database): one small blob per
 * event under ai-feedback/<date>/<instanceId>/<id>.json. Append-only by design —
 * each event is its own object, so there is no read-modify-write race and listing
 * a day's prefix yields the full set. The structured `[ai-feedback]` log line is
 * the authoritative copy (queryable in Vercel logs / a drain) and is never lost.
 */
import { put, list, del } from '@vercel/blob';

export type AiFeedbackSource = 'ai_review' | 'room_scan_live' | 'room_scan' | 'voice_assist';

// What the human did relative to the AI's suggestion.
//  approve  — accepted as-is              decline — rejected outright
//  edit     — accepted but changed values  move   — re-homed to another room
//  remove   — chose to delete the line      add   — added a suggested item
//  ignore   — permanently dismissed a flag  dismiss — transient dismiss (chips)
export type AiFeedbackDecision =
  | 'approve' | 'decline' | 'edit' | 'move' | 'remove' | 'add' | 'ignore' | 'dismiss';

export interface AiFeedbackEvent {
  source: AiFeedbackSource;
  decision: AiFeedbackDecision;
  inspectionId?: string;
  sectionId?: string;
  region?: string;
  /** The AI's original suggestion — the "input" half of the training pair. */
  suggestion: {
    id?: string;
    /** edit | remove | add | wrongRoom | needsPhoto | missingCategory:<cat> | … */
    type?: string;
    /** Suggested (or current) catalog line-item code. */
    catalogCode?: string;
    title?: string;
    /** Severity (high/medium/low) for review, or match confidence for voice/scan. */
    confidence?: string;
    /** The utterance / search that produced it (voice + live camera). */
    query?: string;
  };
  /** What the human changed — the "label" half. Present for edits/moves. */
  correction?: {
    field?: string;
    fromQuantity?: number;
    toQuantity?: number;
    fromTenantPct?: number;
    toTenantPct?: number;
    movedToSectionId?: string;
    note?: string;
  };
  model?: string;
  appVersion?: string;
  /** ISO timestamp; defaulted server-side if absent. */
  ts?: string;
}

const INSTANCE_ID = Math.random().toString(36).slice(2, 10);
let seq = 0;

function today(): string { return new Date().toISOString().slice(0, 10); }

function sanitize(e: AiFeedbackEvent): AiFeedbackEvent {
  // Defensive: keep events small and well-formed; the client is untrusted.
  const clip = (s: unknown, n = 300) => (s == null ? undefined : String(s).slice(0, n));
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  return {
    source: e.source,
    decision: e.decision,
    inspectionId: clip(e.inspectionId, 64),
    sectionId: clip(e.sectionId, 64),
    region: clip(e.region, 64),
    suggestion: {
      id: clip(e.suggestion?.id, 80),
      type: clip(e.suggestion?.type, 64),
      catalogCode: clip(e.suggestion?.catalogCode, 64),
      title: clip(e.suggestion?.title, 200),
      confidence: clip(e.suggestion?.confidence, 32),
      query: clip(e.suggestion?.query, 300),
    },
    correction: e.correction ? {
      field: clip(e.correction.field, 64),
      fromQuantity: num(e.correction.fromQuantity),
      toQuantity: num(e.correction.toQuantity),
      fromTenantPct: num(e.correction.fromTenantPct),
      toTenantPct: num(e.correction.toTenantPct),
      movedToSectionId: clip(e.correction.movedToSectionId, 64),
      note: clip(e.correction.note, 300),
    } : undefined,
    model: clip(e.model, 64),
    appVersion: clip(e.appVersion, 32),
    ts: e.ts || new Date().toISOString(),
  };
}

/** Record a single human-vs-AI decision. Best-effort; never throws. */
export async function recordAiFeedback(raw: AiFeedbackEvent): Promise<void> {
  const e = sanitize(raw);

  // 1) Structured log — authoritative, never lost.
  try { console.log(`[ai-feedback] ${JSON.stringify(e)}`); } catch { /* noop */ }

  // 2) Best-effort: one blob per event (append-only, race-free).
  if (!process.env.BLOB_READ_WRITE_TOKEN) return; // blob not configured → logs only
  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    await put(`ai-feedback/${today()}/${INSTANCE_ID}/${id}.json`,
      JSON.stringify(e),
      { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
  } catch (err: any) {
    console.warn('[ai-feedback] write failed:', String(err?.message || err).slice(0, 120));
  }
}

/** Read all feedback events from the last `days` days. For evals / dashboards. */
export async function readAiFeedback(days = 30): Promise<AiFeedbackEvent[]> {
  const out: AiFeedbackEvent[] = [];
  if (!process.env.BLOB_READ_WRITE_TOKEN) return out;
  const wanted = new Set<string>();
  for (let i = 0; i < days; i++) wanted.add(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  try {
    // List ONLY the requested days' partitions (ai-feedback/<date>/…), in
    // parallel, instead of scanning the entire ai-feedback/ archive and
    // filtering client-side — keeps reads O(days), not O(all-events-ever).
    const perDay = await Promise.all(Array.from(wanted).map(async (date) => {
      const events: AiFeedbackEvent[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: `ai-feedback/${date}/`, cursor, limit: 1000 });
        const evs = await Promise.all(page.blobs.map((b) => fetch(b.url).then((r) => r.json()).catch(() => null)));
        for (const ev of evs) if (ev) events.push(ev as AiFeedbackEvent);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return events;
    }));
    for (const arr of perDay) out.push(...arr);
  } catch (e: any) {
    console.warn('[ai-feedback] read failed:', String(e?.message || e).slice(0, 120));
  }
  return out;
}

/** Delete feedback blobs older than `retentionDays`. Best-effort housekeeping. */
export async function pruneOldAiFeedback(retentionDays = 365): Promise<{ deleted: number; scanned: number }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { deleted: 0, scanned: 0 };
  const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 864e5).toISOString().slice(0, 10);
  let deleted = 0, scanned = 0;
  try {
    let cursor: string | undefined;
    const stale: string[] = [];
    do {
      const page = await list({ prefix: 'ai-feedback/', cursor, limit: 1000 });
      for (const b of page.blobs) {
        scanned++;
        const date = b.pathname.split('/')[1] || '';
        if (date && date < cutoff) stale.push(b.url);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < stale.length; i += 100) {
      await del(stale.slice(i, i + 100));
      deleted += stale.slice(i, i + 100).length;
    }
  } catch (e: any) {
    console.warn('[ai-feedback] prune failed:', String(e?.message || e).slice(0, 120));
  }
  return { deleted, scanned };
}
