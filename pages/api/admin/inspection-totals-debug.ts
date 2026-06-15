/**
 * GET /api/admin/inspection-totals-debug?id=<inspectionRecordId>
 *
 * READ-ONLY diagnostic. Shows exactly what `recomputeInspectionTotals` would sum
 * for one inspection, so we can see why a stored `total_client_cost` rollup
 * diverges from the live/finalized number (e.g. a backfill that produced a wrong
 * total). Writes NOTHING.
 *
 * Returns, for the inspection's rate_card_line answers:
 *   - lines: each line's record id, externalId, code, qty, and stored
 *     vendor/client/tenant snapshots
 *   - rawSum: sum across ALL line answers (what recompute does today)
 *   - dedupedSum: sum keeping only the LATEST record per externalId (what the
 *     form/finalize effectively show) — if this differs from rawSum, stray /
 *     duplicate answer records are inflating the rollup
 *   - duplicateExternalIds: externalIds that appear on more than one record
 *
 * Grab the id from the inspection URL (/inspection/<id>) while signed in as
 * @resihome.com staff.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchAnswersForInspection } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'Pass ?id=<inspectionRecordId> (from the /inspection/<id> URL).' });

  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  try {
    const answers = await fetchAnswersForInspection(id);
    const lineAnswers = answers.filter((a) => a.answerType === 'rate_card_line' && a.rateCardLine);

    const lines = lineAnswers.map((a) => ({
      recordId: a.recordId,
      externalId: a.answerIdExternal,
      code: a.rateCardLine!.lineItemCode,
      section: a.section,
      location: a.location,
      quantity: a.rateCardLine!.quantityDecimal,
      vendorCost: a.rateCardLine!.vendorCost,
      clientCost: a.rateCardLine!.clientCost,
      tenantCost: a.rateCardLine!.tenantCost,
    }));

    // Raw sum = what recomputeInspectionTotals does today (every line answer).
    const rawSum = {
      vendor: round2(lines.reduce((s, l) => s + (Number(l.vendorCost) || 0), 0)),
      client: round2(lines.reduce((s, l) => s + (Number(l.clientCost) || 0), 0)),
      tenant: round2(lines.reduce((s, l) => s + (Number(l.tenantCost) || 0), 0)),
      count: lines.length,
    };

    // Deduped sum = keep only the LAST record seen per externalId.
    const latestByExternal = new Map<string, typeof lines[number]>();
    const externalIdCounts = new Map<string, number>();
    for (const l of lines) {
      externalIdCounts.set(l.externalId, (externalIdCounts.get(l.externalId) || 0) + 1);
      latestByExternal.set(l.externalId, l);
    }
    const deduped = Array.from(latestByExternal.values());
    const dedupedSum = {
      vendor: round2(deduped.reduce((s, l) => s + (Number(l.vendorCost) || 0), 0)),
      client: round2(deduped.reduce((s, l) => s + (Number(l.clientCost) || 0), 0)),
      tenant: round2(deduped.reduce((s, l) => s + (Number(l.tenantCost) || 0), 0)),
      count: deduped.length,
    };

    const duplicateExternalIds = Array.from(externalIdCounts.entries())
      .filter(([, n]) => n > 1)
      .map(([externalId, n]) => ({ externalId, copies: n }));

    return res.status(200).json({
      inspectionId: id,
      rawSum,
      dedupedSum,
      duplicateExternalIds,
      // The biggest individual clientCost snapshots — surfaces a single stale /
      // inflated line at a glance.
      topClientCostLines: [...lines].sort((a, b) => (Number(b.clientCost) || 0) - (Number(a.clientCost) || 0)).slice(0, 10),
      lines,
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
