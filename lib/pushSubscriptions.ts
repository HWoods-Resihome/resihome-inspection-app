/**
 * Push subscription store.
 *
 * Holds the push targets for each user so the server can notify them (e.g. an
 * inspector when their submitted inspection is approved). Deliberately
 * platform-agnostic so the SAME store serves both today's Web Push (installed
 * PWA / browser) and a future native path (Capacitor + FCM token) — see
 * `platform`. The sender (lib/pushSender) decides how to deliver each.
 *
 * Storage mirrors the other Blob logs (no database): one record per target at
 * push-subs/<emailKey>/<idHash>.json. Keying by user email lets us fan out to
 * all of a user's devices and prune dead targets on send.
 */
import { put, list, del } from '@vercel/blob';
import { createHash } from 'crypto';
import type { PushSubscription as WebPushSubscription } from 'web-push';

export type PushPlatform = 'web' | 'native';

export interface StoredPushTarget {
  platform: PushPlatform;
  userEmail: string;
  /** Web Push subscription (platform 'web'). */
  subscription?: WebPushSubscription;
  /** Native device token, e.g. FCM (platform 'native'). */
  token?: string;
  userAgent?: string;
  createdAt: string;
}

// Cap distinct push targets per user. The same device overwrites (stable
// targetId), so growth only comes from a client rotating fake endpoints/tokens;
// this bounds that and keeps fan-out cheap. Oldest beyond the cap are evicted.
const MAX_TARGETS_PER_USER = 20;

function emailKey(email: string): string {
  return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 24);
}

/** Stable id for a target so the same device overwrites rather than duplicates. */
function targetId(t: { subscription?: WebPushSubscription; token?: string }): string {
  const basis = t.subscription?.endpoint || t.token || Math.random().toString(36);
  return createHash('sha256').update(basis).digest('hex').slice(0, 24);
}

function blobPath(email: string, id: string): string {
  return `push-subs/${emailKey(email)}/${id}.json`;
}

/** Save (or refresh) a push target for a user. Best-effort; returns ok. */
export async function savePushTarget(t: {
  platform: PushPlatform; userEmail: string;
  subscription?: WebPushSubscription; token?: string; userAgent?: string;
}): Promise<boolean> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) { console.warn('[push] BLOB token unset — cannot store subscription'); return false; }
  if (!t.userEmail) return false;
  if (t.platform === 'web' && !t.subscription?.endpoint) return false;
  if (t.platform === 'native' && !t.token) return false;
  const record: StoredPushTarget = {
    platform: t.platform, userEmail: t.userEmail.trim().toLowerCase(),
    subscription: t.subscription, token: t.token, userAgent: t.userAgent,
    createdAt: new Date().toISOString(),
  };
  try {
    await put(blobPath(record.userEmail, targetId(t)), JSON.stringify(record),
      { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
  } catch (e: any) {
    console.warn('[push] save target failed:', String(e?.message || e).slice(0, 120));
    return false;
  }
  // Enforce the per-user cap (best-effort): evict the oldest targets beyond it so
  // a client can't mint unbounded push blobs by rotating fake endpoints/tokens.
  try {
    const targets = await getPushTargets(record.userEmail);
    if (targets.length > MAX_TARGETS_PER_USER) {
      const oldestFirst = targets.slice().sort((a, b) =>
        String(a.target.createdAt || '').localeCompare(String(b.target.createdAt || '')));
      const excess = oldestFirst.slice(0, targets.length - MAX_TARGETS_PER_USER);
      await Promise.all(excess.map((x) => deletePushTargetByPath(x.pathname)));
    }
  } catch { /* best-effort cap — never fail the subscribe on eviction trouble */ }
  return true;
}

/** All push targets for a user (across devices). */
export async function getPushTargets(email: string): Promise<{ pathname: string; target: StoredPushTarget }[]> {
  const out: { pathname: string; target: StoredPushTarget }[] = [];
  if (!process.env.BLOB_READ_WRITE_TOKEN || !email) return out;
  try {
    const { blobs } = await list({ prefix: `push-subs/${emailKey(email)}/` });
    const loaded = await Promise.all(blobs.map(async (b) => {
      const target = await fetch(b.url).then((r) => r.json()).catch(() => null);
      return target ? { pathname: b.pathname, target: target as StoredPushTarget } : null;
    }));
    for (const x of loaded) if (x) out.push(x);
  } catch (e: any) {
    console.warn('[push] read targets failed:', String(e?.message || e).slice(0, 120));
  }
  return out;
}

/** Remove a target by its blob pathname (used to prune expired Web Push subs). */
export async function deletePushTargetByPath(pathname: string): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !pathname) return;
  try { await del(pathname); } catch { /* best-effort */ }
}

/** Remove a target for a user by endpoint (web) or token (native). */
export async function removePushTarget(email: string, opts: { endpoint?: string; token?: string }): Promise<void> {
  const id = targetId({ subscription: opts.endpoint ? ({ endpoint: opts.endpoint } as WebPushSubscription) : undefined, token: opts.token });
  await deletePushTargetByPath(blobPath(email, id));
}
