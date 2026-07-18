/**
 * lib/loginActivity.ts — records who has actually signed in, and when.
 *
 * recordLogin() is called from createSessionCookie (the single choke point every
 * auth method funnels through), so one hook covers Google, Microsoft, OTP, the
 * review link, and the native token exchange. Stored as one agent-record JSON
 * blob: lowercased email → { lastAt (ISO), count, name }. Best-effort — a failure
 * must never block a sign-in. A per-instance throttle avoids re-writing on rapid
 * re-auth (e.g. the native app minting a session on every cold start).
 */
import { readLoginActivityRaw, mutateLoginActivityRaw } from '@/lib/hubspot';

const norm = (e?: string | null) => String(e || '').trim().toLowerCase();
const THROTTLE_MS = 15 * 60 * 1000;
const recentWrites = new Map<string, number>(); // per-instance: email → last write ms

export async function recordLogin(email?: string | null, name?: string | null): Promise<void> {
  const e = norm(email);
  if (!e) return;
  const now = Date.now();
  const last = recentWrites.get(e);
  if (last && now - last < THROTTLE_MS) return; // recently stamped on this instance
  recentWrites.set(e, now);
  if (recentWrites.size > 5000) recentWrites.clear(); // bound the map
  try {
    // Concurrency-safe read-modify-write — hundreds of concurrent sign-ins otherwise
    // clobber each other's stamps on this one shared blob.
    await mutateLoginActivityRaw((map) => {
      const prev = map[e] || { lastAt: '', count: 0, name: '' };
      map[e] = {
        lastAt: new Date(now).toISOString(),
        count: (prev.count || 0) + 1,
        name: (name || prev.name || '').toString(),
      };
      return map;
    });
  } catch { /* never block sign-in on a telemetry write */ }
}

/** The whole login map (email → {lastAt,count,name}); {} when unset. */
export async function readLoginActivity(): Promise<Record<string, { lastAt: string; count?: number; name?: string }>> {
  return (await readLoginActivityRaw().catch(() => null)) || {};
}
