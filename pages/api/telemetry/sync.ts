import type { NextApiRequest, NextApiResponse } from 'next';
import { put } from '@vercel/blob';
import { getSessionFromRequest } from '@/lib/auth';
import { recordErrorEvent } from '@/lib/errorLog';

/**
 * Sink for offline-sync telemetry (see lib/syncTelemetry.ts). Logs a structured
 * line and keeps the LATEST sync state per inspection in a Blob so the
 * "stuck work" admin view can list inspections whose edits/photos aren't
 * draining (or were permanently dropped). Overwriting per inspection means a
 * later clean flush (remaining 0) self-clears the entry.
 *
 * Never errors loudly — telemetry must not break the app.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require a session: this writes a PUBLIC blob whose key is derived from the
  // request. Unauthenticated it was a public write sink with an attacker-chosen
  // key and unbounded content. Sync telemetry only fires for signed-in inspectors,
  // so drop anything else silently (telemetry must never error loudly).
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(204).end();

  try {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    // Sanitize hard: the id becomes a blob PATH segment, so strip anything that
    // could traverse into another namespace (`/`, `.`) or collide by charset.
    const inspectionId = String(body?.inspectionId || '').slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '');
    if (inspectionId) {
      const record = {
        inspectionId,
        synced: num(body.synced),
        remaining: num(body.remaining),
        failedPermanently: num(body.failedPermanently),
        outbox: body.outbox || {},
        photos: body.photos || {},
        lastError: body.lastError ? String(body.lastError).slice(0, 300) : undefined,
        online: typeof body.online === 'boolean' ? body.online : undefined,
        updatedAt: new Date().toISOString(),
      };
      console.log('[sync-telemetry]', JSON.stringify(record));
      // Surface genuine sync trouble in the Admin Error Log — but NOT the
      // expected weak-signal churn. A field inspector on a thin uplink produces a
      // steady stream of "Photo upload failed (Load failed)" / "Upload timed out"
      // / "Device is offline" on EVERY flush; the item is safely queued and
      // retries until it lands (never dropped), so logging each attempt just
      // floods the log and buries real crashes. Only escalate when something is
      // actually actionable: work that was permanently dropped, or a hard error
      // that isn't a transient network/offline condition.
      const transientNetwork = !!record.lastError && /load failed|failed to fetch|networkerror|network error|timed out|timeout|offline|connection|aborted|the operation was aborted/i.test(record.lastError);
      const actionable = record.failedPermanently > 0 || (!!record.lastError && !transientNetwork);
      if (actionable) {
        void recordErrorEvent({
          kind: 'sync',
          message: record.lastError || `${record.failedPermanently} queued item(s) failed to sync`,
          email: session.email,
          inspectionId,
          online: record.online,
          source: 'client',
          meta: { synced: record.synced, remaining: record.remaining, failedPermanently: record.failedPermanently },
        });
      }
      if (process.env.BLOB_READ_WRITE_TOKEN) {
        await put(`sync-health/${inspectionId}.json`, JSON.stringify(record),
          { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false })
          .catch((e) => console.warn('[sync-telemetry] write failed:', String(e?.message || e).slice(0, 120)));
      }
    }
  } catch {
    /* swallow — telemetry must never fail loudly */
  }

  return res.status(204).end();
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
function num(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : 0; }
