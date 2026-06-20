/**
 * GET /api/admin/config-check
 *
 * One-stop configuration & schema health check. Reports:
 *   - env:    required/recommended environment variables (HubSpot token, type
 *             IDs, AI keys, blob/cron secrets) present and well-formed.
 *   - schema: HubSpot reachable, type IDs resolve, and the inspection object has
 *             the properties finalize/submit WRITE (a missing one makes finalize
 *             silently degrade to a status-only write — no PDFs, no approval).
 *   - finalChecklist: code↔catalog drift — FC "add line" codes (hardcoded in
 *             lib/finalChecklist.ts) that no longer exist in the live catalog.
 *
 * `ok` is true only when no REQUIRED check fails. Gated to @resihome.com staff.
 * Read-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { fcReferencedLineCodes, fcMissingLineCodes } from '@/lib/finalChecklist';
import { validateEnv, validateSchema, type CheckItem } from '@/lib/configValidation';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const env = validateEnv();
    // Schema (HubSpot round-trip) and catalog run concurrently; both best-effort
    // so one failing area still reports the others.
    const [schema, catalogResult] = await Promise.all([
      validateSchema().catch((e): CheckItem[] => [{ key: 'schema check', ok: false, level: 'required', detail: String(e?.message || e).slice(0, 200) }]),
      (async () => {
        const catalog = await getCachedCatalog();
        const codes = new Set(catalog.map((c) => c.lineItemCode));
        return { size: catalog.length, referenced: fcReferencedLineCodes(), missing: fcMissingLineCodes(codes) };
      })().catch((e) => ({ error: String(e?.message || e).slice(0, 200) } as any)),
    ]);

    const requiredFailures = [...env, ...schema].filter((c) => c.level === 'required' && !c.ok);
    const fcMissing: string[] = catalogResult?.missing || [];
    const ok = requiredFailures.length === 0 && fcMissing.length === 0 && !catalogResult?.error;

    return res.status(200).json({
      ok,
      env,
      schema,
      catalogSize: catalogResult?.size,
      finalChecklist: catalogResult?.error
        ? { error: catalogResult.error }
        : { referencedCodes: catalogResult.referenced, missingCodes: fcMissing },
      summary: {
        requiredFailures: requiredFailures.map((c) => c.key),
        fcMissingCodes: fcMissing,
      },
    });
  } catch (e: any) {
    console.error('[config-check] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
