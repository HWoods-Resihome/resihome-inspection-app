/**
 * Per-user email-notification preferences (server-only). Stored as one agent-record
 * JSON blob: lowercased email → { [notificationKey]: boolean }. An absent value
 * defaults to ON (opt-out model).
 */
import { readNotificationPrefsRaw, writeNotificationPrefsRaw } from '@/lib/hubspot';
import { NOTIFICATION_KEYS, type NotificationKey } from './catalog';

const norm = (email?: string | null) => String(email || '').trim().toLowerCase();

/** A user's effective prefs — every key present, defaulting to ON when unset. */
export async function getNotificationPrefs(email?: string | null): Promise<Record<NotificationKey, boolean>> {
  const all = (await readNotificationPrefsRaw().catch(() => null)) || {};
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
  return writeNotificationPrefsRaw(all);
}

/** True when `email` wants notification `key` (default ON). False on a blank email. */
export async function isNotificationEnabled(email: string | null | undefined, key: NotificationKey): Promise<boolean> {
  if (!norm(email)) return false;
  const prefs = await getNotificationPrefs(email);
  return prefs[key];
}
