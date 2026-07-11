/**
 * GET /api/services/admin/inspect-properties → read-only discovery for wiring the
 * Services rules engine to the REAL Property object. Returns the Property field
 * catalog and the distinct values found on a sample of live records for the
 * candidate portfolio / region / community grouping fields, so we can identify
 * which fields drive coverage without guessing names. Admin-gated. Writes nothing.
 *
 * Optional ?sample=N caps how many records are scanned for distinct values (default 200).
 * Optional ?fields=a,b,c tallies distinct values for those exact fields (overrides
 * the auto-pick). Optional ?catalog=0 drops the full field catalog from the response.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { inspectPropertyFields } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const sample = Math.min(Math.max(Number(req.query.sample) || 200, 1), 1000);
  const fields = typeof req.query.fields === 'string' && req.query.fields.trim()
    ? req.query.fields.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const withCatalog = req.query.catalog !== '0' && req.query.catalog !== 'false';
  try {
    const report = await inspectPropertyFields(sample, fields);
    if (!withCatalog) return res.status(200).json({ typeId: report.typeId, candidates: report.candidates, sampled: report.sampled });
    return res.status(200).json(report);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null });
  }
}
