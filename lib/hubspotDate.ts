/**
 * Normalize a HubSpot datetime value to epoch-ms.
 *
 * HubSpot datetime properties come back in TWO shapes in this codebase:
 *   - epoch-ms as a NUMBER or numeric STRING — e.g. submitted_at / approved_at,
 *     which are WRITTEN via `new Date(iso).getTime()` (see submit.ts / finalize.ts)
 *     and returned by HubSpot as `"1719800000000"`.
 *   - ISO strings — e.g. completed_at.
 *
 * `Date.parse("1719800000000")` is `NaN`, so any code that parses these as ISO
 * silently drops the value (the insights layer did exactly this — turnaround
 * metrics excluded every finalized inspection, table dates showed "—"). Route
 * every HubSpot datetime through here so both shapes parse.
 *
 * Returns ms since epoch, or null when the value is empty/unparseable.
 */
export function hubspotToMs(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    // 13-digit ≈ epoch-ms; 10-digit ≈ epoch-seconds. 1e11 cleanly separates them
    // (1e11 ms ≈ 1973, before any inspection date), so treat < 1e11 as seconds.
    return n >= 1e11 ? n : n * 1000;
  }
  const p = Date.parse(s);
  return Number.isFinite(p) ? p : null;
}

/** Normalize a HubSpot datetime value to an ISO string (or null). */
export function hubspotToIso(v: string | number | null | undefined): string | null {
  const ms = hubspotToMs(v);
  return ms == null ? null : new Date(ms).toISOString();
}
