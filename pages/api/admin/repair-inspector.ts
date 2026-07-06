/**
 * /api/admin/repair-inspector  (admin only)
 *   POST { items: [{ inspectionId, inspectorEmail }], dryRun? }
 *     -> { results: [{ inspectionId, ok, before, after, name, note? }] }
 *
 * One-shot recovery for walks whose inspector_email was silently reassigned to an
 * internal HubSpot owner by the old owner-sync (fixed in syncInspectorFromOwner).
 * Re-stamps each listed inspection's inspector back to the given (1099-agent)
 * email so it re-enters their scoped home list and they can edit it again.
 *
 * Precise by design: the caller supplies explicit inspection ids (surfaced by the
 * Admin Error Log's `write_denied` rows), so we never mass-reassign by guesswork.
 * `dryRun: true` previews the before/after without writing.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { repairInspectorEmail } from '@/lib/hubspot';
import { bustInspectionsCache } from '@/pages/api/inspections';
import { recordErrorEvent } from '@/lib/errorLog';

interface RepairItem { inspectionId?: string; inspectorEmail?: string }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  try {
    const body = (req.body || {}) as { items?: RepairItem[]; dryRun?: boolean };
    const dryRun = body.dryRun === true;
    const items = (Array.isArray(body.items) ? body.items : [])
      .map((it) => ({ inspectionId: String(it?.inspectionId || '').trim(), inspectorEmail: String(it?.inspectorEmail || '').trim() }))
      .filter((it) => it.inspectionId && it.inspectorEmail && it.inspectorEmail.includes('@'))
      .slice(0, 100); // bound a single batch

    if (items.length === 0) return res.status(400).json({ error: 'No valid { inspectionId, inspectorEmail } items.' });

    const results = [];
    for (const it of items) {
      try {
        const r = await repairInspectorEmail(it.inspectionId, it.inspectorEmail, { dryRun });
        results.push({ inspectionId: it.inspectionId, ...r });
      } catch (e: any) {
        results.push({ inspectionId: it.inspectionId, ok: false, before: '', after: it.inspectorEmail, name: '', note: String(e?.message || e).slice(0, 200) });
      }
    }

    if (!dryRun) {
      bustInspectionsCache(); // reflect the reassignment in the lists immediately
      const changed = results.filter((r) => r.ok && r.before.toLowerCase() !== r.after.toLowerCase());
      if (changed.length) {
        void recordErrorEvent({
          kind: 'server',
          message: `Admin repaired inspector on ${changed.length} inspection(s)`,
          email: session.email,
          source: 'server',
          meta: { by: session.email, count: changed.length },
        });
      }
    }

    return res.status(200).json({ dryRun, results });
  } catch (e: any) {
    console.error('[repair-inspector] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
