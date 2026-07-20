/**
 * GET /api/services/admin/generate            → dry-run (default, read-only)
 * GET /api/services/admin/generate?apply=1     → apply (creates Service Work Orders)
 *
 * Phase 3b generation engine for ResiWalk - Services. Reads the persisted Service
 * Rules Engine records and materialises the Service Work Orders they call for.
 * Admin-gated; runs against the PROD HubSpot the preview points at. Dry-run writes
 * nothing — it reports exactly what apply would create. Idempotent: one open order
 * per (rule, target) at a time (see lib/services/generate). No cron yet — manual only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { runServiceGeneration } from '@/lib/services/generate';
import { easternTodayISO } from '@/lib/services/time';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  // POST = live PREVIEW dry-run of an unsaved rule config (body.ruleProps).
  // Always read-only, never applies — an apply must go through the saved record.
  const isPreview = req.method === 'POST';
  const apply = !isPreview && (req.query.apply === '1' || req.query.apply === 'true');
  const onlyRuleId = isPreview
    ? (String((req.body || {}).ruleId || '').trim() || 'preview')
    : (typeof req.query.ruleId === 'string' && req.query.ruleId.trim() ? req.query.ruleId.trim() : undefined);
  const overrideProps = isPreview && (req.body || {}).ruleProps && typeof req.body.ruleProps === 'object'
    ? req.body.ruleProps as Record<string, any> : undefined;
  const today = typeof req.query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.today)
    ? req.query.today : easternTodayISO();
  try {
    const report = await runServiceGeneration(apply, today, onlyRuleId, overrideProps);
    if (report === null) return res.status(200).json({ configured: false, mode: apply ? 'apply' : 'dry-run', note: 'Service Work Order / Service Rule object type ids not set — nothing to generate.' });
    return res.status(200).json(report);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null, mode: apply ? 'apply' : 'dry-run' });
  }
}
