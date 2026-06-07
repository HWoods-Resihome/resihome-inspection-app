import type { NextApiRequest, NextApiResponse } from 'next';
import { put } from '@vercel/blob';

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

  try {
    const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
    const inspectionId = String(body?.inspectionId || '').slice(0, 64);
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
