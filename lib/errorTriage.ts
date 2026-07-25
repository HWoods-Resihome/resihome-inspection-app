/**
 * Error-log TRIAGE: collapse the raw error firehose into a ranked list of
 * DISTINCT issues, each with the diagnostics needed to fix it — so an on-demand
 * triage ("what's broken right now?") is one read, not a scroll through hundreds
 * of near-identical rows.
 *
 * Grouping key = kind + a normalized message template (ids / numbers / uuids /
 * urls masked) so "cannot read x of undefined (id 123)" and "(id 456)" collapse
 * into one issue. Each group carries count, first/last seen, distinct affected
 * users, app versions, routes, a representative stack, and the newest full event.
 * Ranked so what's ACTIVE and FREQUENT floats to the top.
 */
import type { ErrorEvent } from '@/lib/errorLog';

export interface TriageGroup {
  signature: string;      // "kind | normalized message"
  kind: string;
  message: string;        // normalized template
  count: number;
  recentCount: number;    // events in the last 24h
  users: number;          // distinct attributed emails
  firstTs: string;
  lastTs: string;
  versions: string[];     // distinct appVersion (newest-ish first, capped)
  routes: string[];       // distinct url (capped)
  sampleMessage: string;  // a real (un-normalized) message
  stack?: string;         // representative stack, when captured
  inspectionId?: string;  // an example affected record, when relevant
}

export interface TriageReport {
  generatedAt: string;
  scanned: number;
  distinct: number;
  from?: string;
  to?: string;
  groups: TriageGroup[];
}

/** Mask volatile bits so the same bug collapses to one signature. */
export function normalizeMessage(raw: string): string {
  return String(raw || '')
    .replace(/https?:\/\/[^\s"')]+/gi, 'URL')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, 'UUID')
    .replace(/\b[0-9a-f]{7,}\b/gi, 'HEX')
    .replace(/\b\d[\d.,:/_-]*\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const uniqCap = (vals: (string | undefined | null)[], cap: number): string[] => {
  const out: string[] = [];
  for (const v of vals) { const s = String(v || '').trim(); if (s && !out.includes(s)) { out.push(s); if (out.length >= cap) break; } }
  return out;
};

/** Group + rank error events into a triage report. */
export function triageErrorEvents(events: ErrorEvent[], opts: { topN?: number } = {}): TriageReport {
  const topN = opts.topN ?? 25;
  const now = Date.now();
  const DAY = 86400000;
  const groups = new Map<string, ErrorEvent[]>();
  for (const e of events) {
    const key = `${e.kind}|${normalizeMessage(e.message)}`;
    (groups.get(key) || groups.set(key, []).get(key)!).push(e);
  }

  const out: TriageGroup[] = [];
  for (const [signature, evs] of groups) {
    // Sort this group's events newest-first for representative picks.
    evs.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    const newest = evs[0];
    const withStack = evs.find((e) => e.meta && typeof (e.meta as any).stack === 'string');
    const tsList = evs.map((e) => e.ts).filter(Boolean);
    out.push({
      signature,
      kind: String(newest.kind),
      message: normalizeMessage(newest.message),
      count: evs.length,
      recentCount: evs.filter((e) => now - Date.parse(e.ts) < DAY).length,
      users: new Set(evs.map((e) => (e.email || '').trim().toLowerCase()).filter(Boolean)).size,
      firstTs: tsList.reduce((a, b) => (a < b ? a : b), tsList[0] || ''),
      lastTs: newest.ts,
      versions: uniqCap(evs.map((e) => e.appVersion), 5),
      routes: uniqCap(evs.map((e) => e.url), 5),
      sampleMessage: String(newest.message || '').slice(0, 500),
      stack: withStack ? String((withStack.meta as any).stack).slice(0, 2000) : undefined,
      inspectionId: evs.find((e) => e.inspectionId)?.inspectionId,
    });
  }

  // Rank: still-active (recentCount) first, then total frequency, then latest.
  out.sort((a, b) =>
    (b.recentCount - a.recentCount) ||
    (b.count - a.count) ||
    (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));

  const allTs = events.map((e) => e.ts).filter(Boolean).sort();
  return {
    generatedAt: new Date().toISOString(),
    scanned: events.length,
    distinct: out.length,
    from: allTs[0],
    to: allTs[allTs.length - 1],
    groups: out.slice(0, topN),
  };
}

/** A compact, paste-ready text rendering of a triage report (for handing to a
 *  fixer). Kept plain so it drops cleanly into a chat message. */
export function renderTriageText(r: TriageReport): string {
  const lines: string[] = [];
  lines.push(`ResiWalk error triage — ${r.generatedAt}`);
  lines.push(`Scanned ${r.scanned} events (${r.from || '?'} → ${r.to || '?'}), ${r.distinct} distinct issue(s). Top ${r.groups.length}:`);
  lines.push('');
  r.groups.forEach((g, i) => {
    const age = g.recentCount ? `${g.recentCount} in 24h` : 'none in 24h';
    lines.push(`${i + 1}. [${g.kind} ×${g.count} · ${g.users} user(s) · ${age} · last ${g.lastTs}]`);
    lines.push(`   ${g.sampleMessage}`);
    if (g.routes.length) lines.push(`   routes: ${g.routes.join(', ')}`);
    if (g.versions.length) lines.push(`   versions: ${g.versions.join(', ')}`);
    if (g.inspectionId) lines.push(`   example id: ${g.inspectionId}`);
    if (g.stack) lines.push(`   stack: ${g.stack.split('\n').slice(0, 4).join(' ⏎ ')}`);
    lines.push('');
  });
  return lines.join('\n');
}
