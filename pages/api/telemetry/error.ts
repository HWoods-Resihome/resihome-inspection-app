import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { recordErrorEvent } from '@/lib/errorLog';

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

    // Persist for the Admin ▸ ResiWalk Insights Error Log (fire-and-forget; never
    // blocks the 204). Email is server-attributed (reporterEmail), not trusted
    // from the client.
    // Persist the client stack (+ error name) into meta so a minified crash like
    // "Cannot access 'x' before initialization" is LOCATABLE from the Admin Error
    // Log — with source maps the stack's top frame maps straight to the offending
    // file/line. Previously the stack was only in the raw console line, so the
    // dashboard row was an unactionable one-liner. Clipped so a long stack can't
    // bloat the log blob.
    const stack = typeof body.stack === 'string' && body.stack ? body.stack.slice(0, 2500) : undefined;
    const errorName = typeof body.name === 'string' && body.name ? body.name.slice(0, 80) : undefined;
    void recordErrorEvent({
      kind: typeof body.kind === 'string' ? body.kind : 'client',
      message: String(body.message || body.reason || 'Client error'),
      email: record.reporterEmail || (typeof body.email === 'string' ? body.email : undefined),
      inspectionId: typeof body.inspectionId === 'string' ? body.inspectionId : undefined,
      template: typeof body.template === 'string' ? body.template : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
      appVersion: typeof body.appVersion === 'string' ? body.appVersion : undefined,
      url: typeof body.url === 'string' ? body.url : undefined,
      online: typeof body.online === 'boolean' ? body.online : undefined,
      userAgent: typeof body.userAgent === 'string' ? body.userAgent : undefined,
      source: 'client',
<<<<<<< Updated upstream
      // Persist the stack + error name (and the window.onerror/unhandledrejection
      // sub-kind) so triage has a trace to diagnose from — not just the message.
      meta: {
        ...(typeof body.stack === 'string' ? { stack: body.stack.slice(0, 2000) } : {}),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.kind === 'string' ? { reporter: body.kind } : {}),
      },
=======
      meta: (stack || errorName) ? { ...(stack ? { stack } : {}), ...(errorName ? { errorName } : {}) } : undefined,
>>>>>>> Stashed changes
    });

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
