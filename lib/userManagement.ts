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
import { isInternalEmail } from '@/lib/userAccess';

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
  if (ov?.removed) return false;   // hard-removed → no access at all
  return ov?.active !== false; // default active unless explicitly turned off
}

/** Has an admin hard-removed this user (archived)? Removed users are hidden from
 *  the roster and denied everywhere. Seed admins can never be removed. */
export async function isUserRemoved(email: string | null | undefined): Promise<boolean> {
  const e = norm(email);
  if (!e || isSeed(e)) return false;
  return (await getUserOverride(e))?.removed === true;
}

/** Hard-remove a user: mark them removed (drops off the roster + loses access).
 *  The HubSpot-seat archive is done by the caller (API) so this stays pure to
 *  the override store. Seed admins are protected. */
export async function removeUser(email: string | null | undefined, byEmail?: string | null): Promise<boolean> {
  const e = norm(email);
  if (!e || isSeed(e)) return false;
  const by = norm(byEmail);
  const ok = await mutateAppUsers((cur) => {
    const next: AppUsersMap = { ...cur };
    const rec: AppUserRecord = { ...(next[e] || {}) };
    rec.removed = true;
    rec.active = false;
    rec.removedAt = new Date().toISOString();
    if (by) rec.updatedByEmail = by;
    next[e] = rec;
    return next;
  });
  bustUserOverridesCache();
  return ok;
}

/** Inspections access is TRI-STATE:
 *    'none'    — no Inspections app at all,
 *    'limited' — the classic external gating: only their OWN inspections,
 *                only the 1099 template type, completed Scope/QC views only in
 *                regions they've unlocked,
 *    'full'    — unrestricted, like an internal user (any template type, full
 *                visibility).
 *  Defaults (no override): internal users → full; external (1099) → limited.
 *  Legacy boolean overrides: false → none; true → the domain default. */
export type InspectionAccessLevel = 'none' | 'limited' | 'full';
export async function inspectionAccessLevel(email: string | null | undefined): Promise<InspectionAccessLevel> {
  const e = norm(email);
  if (!e) return 'none';
  if (isSeed(e)) return 'full';   // seed admins can never be locked out
  const ov = await getUserOverride(e);
  const v = ov?.inspections;
  if (v === 'none' || v === 'limited' || v === 'full') return v;
  if (v === false) return 'none';
  return isInternalEmail(e) ? 'full' : 'limited';
}

/** Convenience: any inspections access at all (tab visibility / create gate). */
export async function inspectionsEnabled(email: string | null | undefined): Promise<boolean> {
  return (await inspectionAccessLevel(email)) !== 'none';
}

/** Persist a set of per-user overrides (bulk-safe, concurrency-safe). `updates`
 *  is email → partial flags; a flag set to `null` CLEARS that override (back to
 *  fallback), a boolean sets it, `undefined` leaves it untouched. Name is filled
 *  in when known. Seed admins can never be set inactive or non-admin. */
export type UserPatch = {
  name?: string;
  active?: boolean | null;
  inspections?: boolean | InspectionAccessLevel | null;
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
      // Inspections is tri-state: accept the level strings (or boolean/null
      // through the generic path for back-compat).
      if (patch.inspections === 'none' || patch.inspections === 'limited' || patch.inspections === 'full') {
        rec.inspections = patch.inspections;
      } else {
        setFlag('inspections', patch.inspections as boolean | null | undefined);
      }
      setFlag('services', patch.services);
      setFlag('insights', patch.insights);
      setFlag('admin', patch.admin);
      // Inactive cascades: a user set to ResiWalk Active = No has no access
      // anywhere — force every other section off. Applied last so it wins over any
      // other flags in the same patch. Seed admins can never be inactive.
      if (rec.active === false && !seed) {
        rec.inspections = 'none'; rec.services = false; rec.insights = false; rec.admin = false;
      }
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
