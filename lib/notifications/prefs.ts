/**
 * Per-user email-notification preferences (server-only). Stored as one agent-record
 * JSON blob: lowercased email → { [notificationKey]: boolean }. An absent value
 * defaults to ON (opt-out model).
 */
import { readNotificationPrefsRaw, writeNotificationPrefsRaw } from '@/lib/hubspot';
import { NOTIFICATION_KEYS, type NotificationKey } from './catalog';

const norm = (email?: string | null) => String(email || '').trim().toLowerCase();

// Short-TTL cache of the whole prefs blob. A batch action (e.g. nightly generation
// emailing N vendors) otherwise re-reads the entire agent-record JSON once per
// recipient; this collapses that to one HubSpot read per ~10s window.
let _prefsCache: { data: Record<string, Record<string, boolean>>; at: number } | null = null;
const PREFS_TTL_MS = 10_000;
async function readAllPrefs(): Promise<Record<string, Record<string, boolean>>> {
  if (_prefsCache && Date.now() - _prefsCache.at < PREFS_TTL_MS) return _prefsCache.data;
  const all = (await readNotificationPrefsRaw().catch(() => null)) || {};
  _prefsCache = { data: all, at: Date.now() };
  return all;
}

/** A user's effective prefs — every key present, defaulting to ON when unset. */
export async function getNotificationPrefs(email?: string | null): Promise<Record<NotificationKey, boolean>> {
  const all = await readAllPrefs();
  const saved = all[norm(email)] || {};
  const out = {} as Record<NotificationKey, boolean>;
  for (const k of NOTIFICATION_KEYS) out[k] = saved[k] !== false; // default ON
  return out;
}

/** Merge + persist a user's prefs. No-op on a blank email. */
export async function setNotificationPrefs(email: string | null | undefined, prefs: Partial<Record<NotificationKey, boolean>>): Promise<boolean> {
  const e = norm(email);
  if (!e) return false;
  const all = (await readNotificationPrefsRaw().catch(() => null)) || {};
  const clean: Record<string, boolean> = { ...(all[e] || {}) };
  for (const k of NOTIFICATION_KEYS) if (k in prefs && typeof prefs[k] === 'boolean') clean[k] = prefs[k] as boolean;
  all[e] = clean;
  _prefsCache = null;   // a write invalidates the cache
  return writeNotificationPrefsRaw(all);
}

/** True when `email` wants notification `key` (default ON). False on a blank email. */
export async function isNotificationEnabled(email: string | null | undefined, key: NotificationKey): Promise<boolean> {
  if (!norm(email)) return false;
  const prefs = await getNotificationPrefs(email);
  return prefs[key];
}
