/**
 * Push delivery.
 *
 * Sends a notification to every device a user has registered. Web Push targets
 * go out via the `web-push` library (VAPID-signed); expired subscriptions
 * (404/410) are pruned so the store self-heals. Native (FCM) targets are routed
 * to a clearly-marked hook that's wired when the Capacitor native push plugin
 * lands — the store and call sites don't change when that's added.
 *
 * Inert (logs + no-ops) until VAPID env is configured, so the app builds and
 * runs fine before the keys are added to Vercel.
 */
import webpush from 'web-push';
import { getPushTargets, deletePushTargetByPath } from '@/lib/pushSubscriptions';
import { isFcmConfigured, sendFcmToToken } from '@/lib/fcmSender';

export interface PushPayload {
  title: string;
  body: string;
  /** Path/URL to open when the notification is tapped. */
  url?: string;
  tag?: string;
}

let vapidReady: boolean | null = null;

function ensureVapid(): boolean {
  if (vapidReady != null) return vapidReady;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    console.warn('[push] VAPID keys not configured (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) — push disabled.');
    vapidReady = false;
    return false;
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:hwoods@resihome.com';
  try {
    webpush.setVapidDetails(subject, pub, priv);
    vapidReady = true;
  } catch (e: any) {
    console.warn('[push] VAPID setup failed:', String(e?.message || e).slice(0, 120));
    vapidReady = false;
  }
  return vapidReady;
}

/**
 * Notify all of a user's devices. Best-effort; never throws. Returns counts so
 * callers can log delivery. Safe to call when push is unconfigured (no-op).
 */
export async function sendPushToUser(email: string, payload: PushPayload): Promise<{ sent: number; pruned: number; native: number }> {
  let sent = 0, pruned = 0, native = 0;
  if (!email) return { sent, pruned, native };
  const targets = await getPushTargets(email);
  if (!targets.length) return { sent, pruned, native };

  const webReady = ensureVapid();
  const body = JSON.stringify(payload);

  await Promise.all(targets.map(async ({ pathname, target }) => {
    if (target.platform === 'native') {
      // Native (Capacitor) device token → deliver via FCM. Inert until
      // FCM_SERVICE_ACCOUNT_JSON is configured.
      if (!isFcmConfigured() || !target.token) return;
      const r = await sendFcmToToken(target.token, payload);
      if (r === 'sent') native++;
      else if (r === 'expired') { await deletePushTargetByPath(pathname); pruned++; }
      return;
    }
    if (!webReady || !target.subscription) return;
    try {
      await webpush.sendNotification(target.subscription, body);
      sent++;
    } catch (e: any) {
      const status = e?.statusCode;
      if (status === 404 || status === 410) {
        // Subscription expired/unsubscribed — prune so we stop trying.
        await deletePushTargetByPath(pathname);
        pruned++;
      } else {
        console.warn('[push] send failed:', status, String(e?.message || e).slice(0, 120));
      }
    }
  }));

  return { sent, pruned, native };
}
