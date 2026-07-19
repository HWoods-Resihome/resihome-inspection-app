/**
 * Internal user management — per-user access overrides.
 *
 * A single JSON blob on the Agent record (app_users_json) keyed by lowercased
 * email holds each internal user's access toggles: ResiWalk Active, Inspections,
 * Services, Insights, Admin. Each toggle is TRI-STATE — an explicit boolean is an
 * override; `undefined` means "no override", so the app falls back to the legacy
 * behavior (admins-only for services, admin-or-listed for insights, all-internal
 * for inspections, active for everyone). That fallback is what guarantees the new
 * system can't lock anyone out before an admin has configured them.
 *
 * The seed admins (code-defined, un-removable) are always Active and always
 * Admin — the escape hatch so the system can never lock itself out.
 *
 * SERVER-ONLY: reads HubSpot. Never import into a client bundle. The higher-level
 * gates (isAppAdmin / servicesEnabled / canViewInsights) live in their own files
 * and call getUserOverride here; this module imports none of them (no cycles).
 */
import { readAppUsers, mutateAppUsers, type AppUserRecord, type AppUsersMap } from '@/lib/hubspot';
import { AI_KNOWLEDGE_ADMINS } from '@/lib/aiKnowledgeAccess';

const SEED = new Set(AI_KNOWLEDGE_ADMINS.map((e) => e.trim().toLowerCase()));
const isSeed = (email: string) => SEED.has(email);

const norm = (e?: string | null) => String(e || '').trim().toLowerCase();

// 60s cache (mirrors adminAccess/insightsAccess) so gating doesn't hit HubSpot on
// every request.
let _cache: { map: AppUsersMap; at: number } | null = null;
const TTL_MS = 60_000;

async function overridesMap(): Promise<AppUsersMap> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.map;
  let map: AppUsersMap = {};
  try { map = await readAppUsers(); } catch { /* best-effort → treat as none */ }
  _cache = { map, at: Date.now() };
  return map;
}

export function bustUserOverridesCache(): void { _cache = null; }

/** The stored override record for a user (or undefined if never configured). */
export async function getUserOverride(email: string | null | undefined): Promise<AppUserRecord | undefined> {
  const e = norm(email);
  if (!e) return undefined;
  return (await overridesMap())[e];
}

/** ResiWalk Active — may this user use the app at all? Seed admins are always
 *  active; everyone else is active unless explicitly disabled. */
export async function isResiwalkActive(email: string | null | undefined): Promise<boolean> {
  const e = norm(email);
  if (!e) return false;
  if (isSeed(e)) return true;
  const ov = await getUserOverride(e);
  return ov?.active !== false; // default active unless explicitly turned off
}

/** Inspections access. Explicit override wins; otherwise the legacy default —
 *  TRUE for everyone who can sign in (inspections was never gated before).
 *  NOTE this flag only gates app entry/creation for internal users; external
 *  1099 users are constrained by the 1099 guards regardless (own-template
 *  writes, own-inspection edits, region-unlocked completed views) — those
 *  never consult this flag, so turning it on can't widen a 1099's access. */
export async function inspectionsEnabled(email: string | null | undefined): Promise<boolean> {
  const e = norm(email);
  if (!e) return false;
  const ov = await getUserOverride(e);
  if (ov && typeof ov.inspections === 'boolean') return ov.inspections;
  return true;
}

/** Persist a set of per-user overrides (bulk-safe, concurrency-safe). `updates`
 *  is email → partial flags; a flag set to `null` CLEARS that override (back to
 *  fallback), a boolean sets it, `undefined` leaves it untouched. Name is filled
 *  in when known. Seed admins can never be set inactive or non-admin. */
export type UserPatch = {
  name?: string;
  active?: boolean | null;
  inspections?: boolean | null;
  services?: boolean | null;
  insights?: boolean | null;
  admin?: boolean | null;
};
export async function applyUserPatches(updates: Record<string, UserPatch>, byEmail?: string | null): Promise<boolean> {
  const by = norm(byEmail);
  const nowIso = new Date().toISOString();
  const ok = await mutateAppUsers((cur) => {
    const next: AppUsersMap = { ...cur };
    for (const [rawEmail, patch] of Object.entries(updates)) {
      const e = norm(rawEmail);
      if (!e) continue;
      const rec: AppUserRecord = { ...(next[e] || {}) };
      const seed = isSeed(e);
      const setFlag = (key: 'active' | 'inspections' | 'services' | 'insights' | 'admin', v: boolean | null | undefined) => {
        if (v === undefined) return;
        // Seed admins are permanently active + admin — never let the UI disable them.
        if (seed && (key === 'active' || key === 'admin') && v !== true) return;
        if (v === null) delete rec[key];
        else rec[key] = v;
      };
      if (typeof patch.name === 'string' && patch.name.trim()) rec.name = patch.name.trim();
      setFlag('active', patch.active);
      setFlag('inspections', patch.inspections);
      setFlag('services', patch.services);
      setFlag('insights', patch.insights);
      setFlag('admin', patch.admin);
      rec.updatedAt = nowIso;
      if (by) rec.updatedByEmail = by;
      next[e] = rec;
    }
    return next;
  });
  bustUserOverridesCache();
  return ok;
}

export { isSeed as isSeedUserEmail };
