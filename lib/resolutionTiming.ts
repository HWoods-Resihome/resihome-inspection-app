/**
 * Internal Resolution completion timing — per-line, per-inspection.
 *
 * When a line is assigned to Internal Resolution the inspector picks whether the
 * work is being done "now" (after-photos required + enforced at finalize) or
 * "later" (deferred — after-photos optional for now). Stored in localStorage
 * (device-local), mirroring the AI photo-ignore store; the finalize gate reads
 * it to decide whether to require an after-photo on each IR line.
 *
 * Default when unset is "now", preserving the strict (always-require) behavior
 * until the inspector explicitly defers a line.
 */

export type ResolutionTiming = 'now' | 'later';

const KEY = 'resiwalk_resolution_timing_v1';

function readAll(): Record<string, Record<string, ResolutionTiming>> {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(window.localStorage.getItem(KEY) || '{}') || {}; }
  catch { return {}; }
}

/** Map of lineExternalId -> timing for one inspection. */
export function getResolutionTimings(inspectionId: string): Record<string, ResolutionTiming> {
  return readAll()[inspectionId] || {};
}

export function setResolutionTiming(inspectionId: string, lineExternalId: string, value: ResolutionTiming): void {
  if (typeof window === 'undefined' || !inspectionId || !lineExternalId) return;
  try {
    const all = readAll();
    const forInspection = { ...(all[inspectionId] || {}) };
    forInspection[lineExternalId] = value;
    all[inspectionId] = forInspection;
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage disabled */ }
}
