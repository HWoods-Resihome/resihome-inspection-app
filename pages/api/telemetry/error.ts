import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';

/**
 * Sink for client-side error reports (see lib/clientErrorReporter.ts). Logs a
 * structured line so field crashes/silent failures show up in the server logs
 * (e.g. Vercel) instead of only on the inspector's device. If ERROR_WEBHOOK_URL
 * is set, the report is also forwarded there (Slack/Sentry/any HTTP collector).
 *
 * This endpoint deliberately does NOT require the data to be well-formed and
 * never errors loudly — telemetry should never break the app. It stays open to
 * unauthenticated callers ON PURPOSE so pre-login crashes (login/install pages)
 * are still captured; the session email is attached only for attribution.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    const session = await getSessionFromRequest(req).catch(() => null);
    const record = {
      ...body,
      // Server-authoritative fields — placed AFTER the spread so a caller can't
      // override level/source (log/alert-channel poisoning) or spoof context.
      level: 'error',
      source: 'client',
      reporterEmail: session?.email || undefined,
      receivedAt: new Date().toISOString(),
      ip: (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || undefined,
    };

    // Structured log line — greppable in Vercel/CloudWatch.
    console.error('[client-error]', JSON.stringify(record));

    const webhook = process.env.ERROR_WEBHOOK_URL;
    if (webhook) {
      // Fire-and-forget; don't hold the response on a slow collector.
      void fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      }).catch(() => {});
    }
  } catch {
    /* swallow — telemetry must never fail loudly */
  }

  // 204: accepted, nothing to return. Always succeed.
  return res.status(204).end();
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return { raw: String(s).slice(0, 1000) }; }
}
