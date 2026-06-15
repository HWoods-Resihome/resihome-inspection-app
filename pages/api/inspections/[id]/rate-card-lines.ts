import type { NextApiRequest, NextApiResponse } from 'next';
import {
  upsertAnswers,
  archiveAnswers,
  updateInspection,
  touchInspection,
  fetchInspectionById,
  fetchAnswersForInspection,
  recomputeInspectionTotals,
  type AnswerUpsert,
} from '@/lib/hubspot';
import { externalWriteDenial } from '@/lib/inspectionGuard';
import { bustInspectionsCache } from '@/pages/api/inspections';
import { getSessionFromRequest } from '@/lib/auth';
import { calculateLine, roundMoney } from '@/lib/rateCardMath';
import { getCachedRegions } from '@/pages/api/rate-card/regions';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
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
  // Saves can batch several lines; give headroom over the 10s default so a
  // multi-line save under load doesn't time out mid-write.
  maxDuration: 30,
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

  // Rate Card is internal-only; external (1099) users are denied (defense-in-depth).
  const xDenial = await externalWriteDenial(session.email, inspectionRecordId);
  if (xDenial) return res.status(403).json({ error: xDenial });

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
    // Per-line "the requested region wasn't in the matrix, so this priced off the
    // GA: Atlanta fallback" flag — surfaced (not blocked) so a silent mispricing
    // is at least visible/auditable.
    const regionFallbackByExternalId = new Map<string, boolean>();

    // Resolve the region we'll use. Saved on the inspection at creation time
    // (region_snapshot). If empty, math falls back to GA:Atlanta.
    // The InspectionSummary type doesn't have region_snapshot yet — we read it
    // from the raw inspection load instead. Cheaper to use whatever's in
    // inspection until that's wired in.
    const region = (inspection as any).regionSnapshot
                || (inspection as any).region_snapshot
                || ''; // empty triggers fallback

    // Look codes up against the cached catalog (one load, reused) instead of a
    // per-line HubSpot search — that N+1 against the slowest CRM endpoint could
    // time out / rate-limit a multi-line save.
    const catalogList = await getCachedCatalog();
    const catalogByCode = new Map(catalogList.map((c) => [c.lineItemCode, c]));

    for (const u of upserts) {
      const line = u.line;
      if (!line?.lineItemCode) {
        return res.status(400).json({ error: 'Missing lineItemCode in upsert' });
      }
      const catalog = catalogByCode.get(line.lineItemCode);
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
      // Flag a region fallback: we asked for a specific region but the matrix
      // didn't have it, so calc used GA: Atlanta. (Empty requested region = no
      // region chosen yet → fallback is expected, not a flag.)
      const reqRegion = (region || '').trim();
      const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
      regionFallbackByExternalId.set(line.externalId, !!reqRegion && norm(reqRegion) !== norm(String(calc.regionSnapshot || '')));

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
      // After photos (Internal Resolution proof-of-work). Only include when the
      // line actually has some, so saves stay resilient if the after_photo_urls
      // property hasn't been created yet (the per-item fallback then surfaces
      // just that line instead of failing the whole batch). Empty/absent => the
      // field is simply not written.
      if (Array.isArray(line.afterPhotoUrls) && line.afterPhotoUrls.length > 0) {
        props.after_photo_urls = line.afterPhotoUrls.join(',');
      }

      answerUpserts.push({
        recordId: u.recordId,
        answerProps: props,
        // Rate card lines don't associate to a Question (no question record).
        questionHubspotRecordId: null,
      });
    }

    // Resolve any missing recordIds against the inspection's existing answers,
    // so a line we already saved UPDATEs (by record id) instead of attempting a
    // CREATE that collides on the unique answer_id_external (HubSpot 400). This
    // happens when an edit/move arrives without a mapped recordId (e.g. after a
    // reload, or an AI-applied change to a line saved in a prior session).
    if (answerUpserts.some((u) => !u.recordId)) {
      try {
        const existing = await fetchAnswersForInspection(inspectionRecordId);
        const byExt = new Map(existing.map((a) => [a.answerIdExternal, a.recordId]));
        for (const u of answerUpserts) {
          if (!u.recordId) {
            const rid = byExt.get(u.answerProps.answer_id_external as string);
            if (rid) u.recordId = rid;
          }
        }
      } catch (e) {
        console.warn('[rate-card-lines] could not resolve existing recordIds:', e);
      }
    }

    // Persist (resilient). Try the fast batch first; if HubSpot rejects it
    // (e.g. one bad line 400s the whole batch), fall back to per-item so the
    // good lines still save and we can name + surface the one that failed,
    // instead of failing the entire apply with a 500.
    let upsertResults: Array<{ recordId: string; answerIdExternal: string }> = [];
    const failures: { code: string; error: string }[] = [];
    if (answerUpserts.length > 0) {
      try {
        upsertResults = await upsertAnswers(inspectionRecordId, answerUpserts);
      } catch (batchErr: any) {
        console.warn(`[rate-card-lines] batch upsert failed (${answerUpserts.length} items) — retrying per-item:`, (batchErr?.detail || batchErr?.message || batchErr));
        for (const u of answerUpserts) {
          try {
            const r = await upsertAnswers(inspectionRecordId, [u]);
            upsertResults.push(...r);
          } catch (itemErr: any) {
            failures.push({
              code: String(u.answerProps?.rate_card_line_item_code || u.answerProps?.answer_id_external || 'line'),
              error: String(itemErr?.detail || itemErr?.message || itemErr).slice(0, 200),
            });
          }
        }
      }
    }

    // Archives one-at-a-time so a single stale/already-archived id can't fail
    // the batch (HubSpot 400s the whole batch otherwise).
    for (const rid of archives) {
      try { await archiveAnswers([rid]); }
      catch (e: any) { failures.push({ code: `archive ${rid}`, error: String(e?.detail || e?.message || e).slice(0, 160) }); }
    }
    // Stamp "last edited" so the list can sort by most-recently-touched.
    await touchInspection(inspectionRecordId).catch(() => { /* non-fatal */ });

    // Keep the inspection's rolled-up cost totals (total_vendor/client/tenant_cost)
    // in sync with the current scope after this add/edit/delete. Best-effort —
    // never fail the save over the summary write.
    await recomputeInspectionTotals(inspectionRecordId, { catalog: catalogList, regions, region }).catch((e) => {
      console.warn(`[rate-card-lines] totals recompute failed for ${inspectionRecordId} (non-fatal):`, e);
    });
    // Drop the cached home list/counts so the updated Client $ total shows on the
    // card the moment the inspector returns to the list (no 15s cache lag).
    bustInspectionsCache();

    // Stitch the math result back to each saved record so the client can update
    // its UI without re-fetching.
    const results = upsertResults.map((r) => {
      const calc = calcByExternalId.get(r.answerIdExternal);
      const regionFallback = regionFallbackByExternalId.get(r.answerIdExternal) === true;
      // Structured audit record for a VOICE-added line (externalId prefix
      // "voice_"). Joins to the [voice-line] log emitted by the voice endpoint
      // (which carries the utterance + match confidence) via answerIdExternal, so
      // a wrong match is fully reconstructable after the fact: utterance →
      // transcript → matched code → confidence → written row → priced region.
      if (calc && /^voice_/.test(r.answerIdExternal)) {
        try {
          console.log(`[voice-line] ${JSON.stringify({
            event: 'written',
            inspectionId: inspectionRecordId,
            answerIdExternal: r.answerIdExternal,
            recordId: r.recordId,
            regionUsed: calc.regionSnapshot,
            regionFallback,
            vendorCost: roundMoney(calc.vendorCost),
            clientCost: roundMoney(calc.clientCost),
            tenantCost: roundMoney(calc.tenantCost),
          })}`);
        } catch { /* logging is best-effort */ }
      }
      return {
        recordId: r.recordId,
        answerIdExternal: r.answerIdExternal,
        regionFallback,
        totals: calc
          ? {
              laborTotal: roundMoney(calc.laborTotal),
              materialTotal: roundMoney(calc.materialTotal),
              vendorCost: roundMoney(calc.vendorCost),
              clientCost: roundMoney(calc.clientCost),
              tenantCost: roundMoney(calc.tenantCost),
              regionUsed: calc.regionSnapshot,
              regionFallback,
              isCustomPriced: calc.isCustomPriced,
            }
          : null,
      };
    });

    const elapsed = Date.now() - t0;
    if (elapsed > 5000) {
      console.warn(`[rate-card-lines] slow save: ${elapsed}ms, upserts=${upserts.length}`);
    }

    // 200 even with partial failures (the good lines saved); the client surfaces
    // `failures` so the inspector knows exactly which line + why.
    return res.status(200).json({ success: failures.length === 0, results, failures, elapsedMs: elapsed });
  } catch (e: any) {
    console.error(`POST /api/inspections/${inspectionRecordId}/rate-card-lines failed:`, e);
    // Include the upstream detail (HubSpot's actual validation message) so field
    // sync failures can be diagnosed instead of guessed.
    const detail = (e as any)?.detail;
    return res.status(500).json({ error: String(e?.message || e), detail: detail ? String(detail).slice(0, 400) : undefined });
  }
}
