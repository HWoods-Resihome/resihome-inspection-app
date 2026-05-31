import type { NextApiRequest, NextApiResponse } from 'next';
import {
  upsertAnswers,
  archiveAnswers,
  updateInspection,
  touchInspection,
  fetchInspectionById,
  fetchRateCardLineItemByCode,
  type AnswerUpsert,
} from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { getCachedRegions } from '@/pages/api/rate-card/regions';
import type { RateCardLineInput } from '@/lib/types';

/**
 * POST /api/inspections/[id]/rate-card-lines
 *
 * Save/update rate card lines for an inspection. Server-authoritative math:
 * the client sends inputs (line_item_code, quantity, vendor, tenant %, etc.)
 * and the server independently computes all totals using the catalog + region
 * matrix, snapshots them, then upserts the answer records.
 *
 * Body shape:
 *   {
 *     upserts: Array<{ recordId?: string, line: RateCardLineInput }>,
 *     archives?: string[],                       // answer record ids to delete
 *     bumpStatusToInProgress?: boolean,          // first-edit transition
 *   }
 *
 * Returns:
 *   {
 *     success: true,
 *     results: Array<{ recordId, answerIdExternal, totals: LineTotals }>,
 *     elapsedMs: number,
 *   }
 */

export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
};

interface BodyShape {
  upserts: Array<{
    recordId?: string;
    line: RateCardLineInput;
  }>;
  archives?: string[];
  bumpStatusToInProgress?: boolean;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id: inspectionRecordId } = req.query;
  if (!inspectionRecordId || typeof inspectionRecordId !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  try {
    const body = req.body as BodyShape;
    const upserts = body?.upserts || [];
    const archives = body?.archives || [];
    const t0 = Date.now();

    // Load the inspection so we know its region_snapshot. If it's missing,
    // the math layer falls back to GA:Atlanta / Inspections automatically.
    const inspection = await fetchInspectionById(inspectionRecordId);
    if (!inspection) return res.status(404).json({ error: 'Inspection not found' });

    // Cached region rates (loaded once per server instance, refreshed every 60 min)
    const regions = await getCachedRegions();
    if (regions.length === 0) {
      return res.status(500).json({
        error: 'No region rates loaded. Run phase1_step5 to load region data, or check HubSpot connection.',
      });
    }

    // Server-side status transition (mirrors /answers behavior)
    if (body.bumpStatusToInProgress) {
      const s = (inspection.status || '').toLowerCase();
      if (s === 'scheduled') {
        await updateInspection(inspectionRecordId, {
          status: 'in_progress',
          started_at: new Date().toISOString(),
        });
      }
    }

    // Build the answer upserts: for each input, look up the catalog item,
    // run the math, build answer properties.
    const answerUpserts: AnswerUpsert[] = [];
    const calcByExternalId = new Map<string, ReturnType<typeof calculateLine>>();

    // Resolve the region we'll use. Saved on the inspection at creation time
    // (region_snapshot). If empty, math falls back to GA:Atlanta.
    // The InspectionSummary type doesn't have region_snapshot yet — we read it
    // from the raw inspection load instead. Cheaper to use whatever's in
    // inspection until that's wired in.
    const region = (inspection as any).regionSnapshot
                || (inspection as any).region_snapshot
                || ''; // empty triggers fallback

    for (const u of upserts) {
      const line = u.line;
      if (!line?.lineItemCode) {
        return res.status(400).json({ error: 'Missing lineItemCode in upsert' });
      }
      const catalog = await fetchRateCardLineItemByCode(line.lineItemCode);
      if (!catalog) {
        return res.status(400).json({
          error: `Catalog item not found: ${line.lineItemCode}`,
        });
      }

      // Validate numeric inputs up front so a malformed payload is a clean 400
      // rather than a 500 from the math layer (or, worse, a silently-stored $0
      // line if the guards were ever removed).
      const qtyNum = Number(line.quantity);
      if (!isFinite(qtyNum) || qtyNum < 0) {
        return res.status(400).json({
          error: `Invalid quantity for line ${line.lineItemCode}: ${JSON.stringify(line.quantity)}`,
        });
      }
      const pctNum = Number(line.tenantBillBackPercent);
      if (line.tenantBillBackPercent != null && (!isFinite(pctNum) || pctNum < 0 || pctNum > 100)) {
        return res.status(400).json({
          error: `Invalid tenant bill-back % for line ${line.lineItemCode}: ${JSON.stringify(line.tenantBillBackPercent)}`,
        });
      }

      const calc = calculateLine(catalog, region, regions, {
        quantity: qtyNum,
        tenantBillBackPercent: isFinite(pctNum) ? pctNum : 0,
        customLaborRate: line.customLaborRate ?? null,
        customAdjustedMaterialCost: line.customAdjustedMaterialCost ?? null,
        customVendorCost: line.customVendorCost ?? null,
      });
      calcByExternalId.set(line.externalId, calc);

      // Build the answer record properties.
      // Reuse the existing answer schema (we extended it in Phase 1, Step 3).
      // For consistency with non-rate-card answers, populate question_text with
      // the labor short description (per Phase 1 Q-S decision).
      const props: Record<string, any> = {
        // Standard answer fields (existing schema)
        answer_id_external: line.externalId,
        inspection_id_external: inspection.inspectionIdExternal,
        answer_type: 'rate_card_line',
        section: line.section || '',
        location: line.location || '',
        // answer_value holds the description shown to the user (and copied to QC
        // + PDFs). If the inspector overrode the description, store that; else
        // store the catalog's labor subtext (newer field), falling back to the
        // short description for any item without a subtext yet.
        answer_value: (line.customLaborFullDescription || catalog.laborSubtext || catalog.laborShortDescription || '').slice(0, 65000),
        // answer_summary is REQUIRED on the inspection_answer schema. For rate
        // card lines we synthesize one from "<section> / <line item label>"
        // (e.g. "Yard / Exterior / Replace gutter section"). Without this the
        // entire create fails with VALIDATION_ERROR.
        answer_summary: `${line.section || 'Rate Card'} / ${catalog.laborShortDescription}`.slice(0, 250),
        note: line.note || '',
        assigned_to: line.assignedTo || '',
        photo_urls: (line.photoUrls || []).join(','),
        quantity: roundMoney(line.quantity),

        // Rate card line metadata
        rate_card_line_item_code: line.lineItemCode,
        quantity_decimal: line.quantity,
        // Coerce defensively: a missing percent must not persist the string "NaN".
        tenant_bill_back_percent: String(Math.round(Number(line.tenantBillBackPercent) || 0)),
        is_custom_priced: calc.isCustomPriced ? 'true' : 'false',

        // Snapshots
        category_snapshot: calc.categorySnapshot,
        subcategory_snapshot: calc.subcategorySnapshot,
        region_snapshot: calc.regionSnapshot,
        labor_hours_snapshot: calc.laborHoursSnapshot,
        labor_hourly_rate_snapshot: calc.laborHourlyRateSnapshot,
        material_rate_snapshot: calc.materialRateSnapshot,
        material_qty_snapshot: calc.materialQtySnapshot,
        material_cost_snapshot: calc.materialCostSnapshot,
        material_cost_adjustment_snapshot: calc.materialCostAdjustmentSnapshot,
        material_tax_adjustment_snapshot: calc.materialTaxAdjustmentSnapshot,
        is_labor_only_snapshot: calc.isLaborOnlySnapshot ? 'true' : 'false',
        is_bid_item_snapshot: calc.isBidItemSnapshot ? 'true' : 'false',

        // Computed totals (rounded for storage — full precision used in math)
        labor_total: roundMoney(calc.laborTotal),
        material_total: roundMoney(calc.materialTotal),
        vendor_cost: roundMoney(calc.vendorCost),
        client_cost: roundMoney(calc.clientCost),
        tenant_cost: roundMoney(calc.tenantCost),
      };
      // Only include override fields when set. If the Phase 3c migration hasn't
      // been run yet, sending these fields (even as empty strings) causes
      // HubSpot to reject the entire record as "unknown property". Omitting
      // them when unset keeps the save path resilient.
      if (line.customLaborRate != null) {
        props.custom_labor_rate = line.customLaborRate;
      }
      if (line.customAdjustedMaterialCost != null) {
        props.custom_adjusted_material_cost = line.customAdjustedMaterialCost;
      }
      if (line.customVendorCost != null) {
        props.custom_vendor_cost = line.customVendorCost;
      }

      answerUpserts.push({
        recordId: u.recordId,
        answerProps: props,
        // Rate card lines don't associate to a Question (no question record).
        questionHubspotRecordId: null,
      });
    }

    // Persist
    const upsertResults = answerUpserts.length > 0
      ? await upsertAnswers(inspectionRecordId, answerUpserts)
      : [];

    if (archives.length > 0) {
      await archiveAnswers(archives);
    }
    // Stamp "last edited" so the list can sort by most-recently-touched.
    await touchInspection(inspectionRecordId);

    // Stitch the math result back to each saved record so the client can update
    // its UI without re-fetching.
    const results = upsertResults.map((r) => {
      const calc = calcByExternalId.get(r.answerIdExternal);
      return {
        recordId: r.recordId,
        answerIdExternal: r.answerIdExternal,
        totals: calc
          ? {
              laborTotal: roundMoney(calc.laborTotal),
              materialTotal: roundMoney(calc.materialTotal),
              vendorCost: roundMoney(calc.vendorCost),
              clientCost: roundMoney(calc.clientCost),
              tenantCost: roundMoney(calc.tenantCost),
              regionUsed: calc.regionSnapshot,
              isCustomPriced: calc.isCustomPriced,
            }
          : null,
      };
    });

    const elapsed = Date.now() - t0;
    if (elapsed > 5000) {
      console.warn(`[rate-card-lines] slow save: ${elapsed}ms, upserts=${upserts.length}`);
    }

    return res.status(200).json({ success: true, results, elapsedMs: elapsed });
  } catch (e: any) {
    console.error(`POST /api/inspections/${inspectionRecordId}/rate-card-lines failed:`, e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
