import type { NextApiRequest, NextApiResponse } from 'next';
import {
  fetchInspectionWithPropertyRef,
  fetchAnswersForInspection,
  fetchInspectionById,
  updateInspection,
  answerHasAfterPhotoProperty,
  fetchPropertyFieldOptions,
  fetchActiveListingForProperty,
  parseListingSnapshot,
  fetchPropertyCommunityName,
  syncInspectorFromOwner,
} from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';
import { buildShortLink } from '@/lib/shortLinks';
import { externalAccessDenial } from '@/lib/userAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  if (req.method === 'GET') {
    try {
      // Answers only need the route id (not the inspection record), so kick that
      // fetch off IN PARALLEL with the inspection+property fetch — these are the
      // two slowest calls on this hot path, and overlapping them removes a serial
      // round-trip per detail open. A rejection still surfaces below (we await it
      // in the Promise.all); attach a no-op catch on the early-return paths so it
      // can't become an unhandled rejection.
      const answersPromise = fetchAnswersForInspection(id);
      const data = await fetchInspectionWithPropertyRef(id);
      if (!data) { answersPromise.catch(() => {}); return res.status(404).json({ error: 'Inspection not found' }); }
      // External (1099) users can open any 1099, plus COMPLETED Scope Rate Card
      // / Re-Inspect inspections (view-only). Pass the status so the read rule
      // can allow completed view-only types and reject non-completed ones.
      const denial = externalAccessDenial(session.email, data.inspection.templateType, {
        status: data.inspection.status,
      });
      if (denial) { answersPromise.catch(() => {}); return res.status(403).json({ error: denial }); }
      // Answers + the property's active listing + (Community/Visit only) the
      // associated community's name — all best-effort, in parallel.
      // Keep the inspector in sync with the HubSpot record Owner: if the owner
      // was reassigned in HubSpot, re-stamp inspector_name/email (the app's
      // source of truth) and reflect it in this response so the change shows
      // immediately on open. Best-effort; no-op when already in sync.
      try {
        const synced = await syncInspectorFromOwner(id);
        if (synced) {
          data.inspection.inspectorName = synced.name;
          data.inspection.inspectorEmail = synced.email;
        }
      } catch { /* best-effort — never blocks the detail load */ }

      const isCommunityTpl = data.inspection.templateType === 'pm_community_inspection';
      // The Final Checklist (mailbox-keys question) renders on scope / 1099 /
      // vacancy and is gated on the property's Community association, so fetch the
      // community name for those too — not only the Community template's header.
      const FC_OR_COMMUNITY = new Set([
        'pm_community_inspection', 'pm_scope_rate_card',
        'leasing_agent_1099_property_inspection', 'pm_vacancy_occupancy_check',
      ]);
      const wantCommunity = FC_OR_COMMUNITY.has(data.inspection.templateType);
      // Prefer the FROZEN listing snapshot (set at completion) so a completed
      // inspection shows the listing as it was at the time of inspection; fall
      // back to a live lookup while it's still in progress (no snapshot yet).
      const listingSnapshot = parseListingSnapshot(data.listingSnapshotJson);
      const [answers, listing, communityName] = await Promise.all([
        answersPromise,
        listingSnapshot
          ? Promise.resolve(listingSnapshot)
          : (data.propertyIdRef
            ? fetchActiveListingForProperty(data.propertyIdRef).catch(() => null)
            : Promise.resolve(null)),
        (wantCommunity && data.propertyIdRef)
          ? fetchPropertyCommunityName(data.propertyIdRef).catch(() => null)
          : Promise.resolve(null),
      ]);

      // Clean short links (resolve to the real files via /d/...) for whatever
      // PDFs this inspection has — works for ALL templates: Rate Card
      // (master/chargeback/xlsx/vendors) and the single report PDF used by
      // question templates + QC reinspect. The client uses these for downloads.
      const shareHost = req.headers['x-forwarded-host'] || req.headers.host || '';
      const shareProto = (req.headers['x-forwarded-proto'] as string) || 'https';
      const shareBase = shareHost ? `${shareProto}://${shareHost}` : '';
      const insp = data.inspection;
      const vendors: Record<string, string> = {};
      if (insp.pdfVendorUrlsJson) {
        try {
          const map = JSON.parse(insp.pdfVendorUrlsJson) || {};
          for (const [vendor, url] of Object.entries(map)) {
            if (typeof url === 'string' && url) vendors[vendor] = buildShortLink(shareBase, id, 'vendor', vendor);
          }
        } catch { /* ignore malformed */ }
      }
      const shareLinks = {
        master: insp.pdfMasterUrl ? buildShortLink(shareBase, id, 'master') : null,
        chargeback: insp.pdfChargebackUrl ? buildShortLink(shareBase, id, 'chargeback') : null,
        xlsx: insp.pdfChargebackXlsxUrl ? buildShortLink(shareBase, id, 'xlsx') : null,
        report: insp.pdfUrl ? buildShortLink(shareBase, id, 'report') : null,
        vendors,
      };

      // Final Checklist (scope only): pull the air-filter size dropdown options
      // live from the HubSpot field definitions so the scroll-wheels stay in
      // sync with HubSpot. Union the three type fields' options, sorted ascending.
      // Computed for Scope AND the question-form templates (their HVAC widget
      // uses the same air-filter size options). Skipped only for QC turn-reinspect
      // (no air-filter section).
      let filterSizeOptions: string[] = [];
      if (data.inspection.templateType !== 'pm_turn_reinspect_qc') {
        try {
          const lists = await Promise.all([
            fetchPropertyFieldOptions('air_filters___type__1'),
            fetchPropertyFieldOptions('air_filters___type__2'),
            fetchPropertyFieldOptions('air_filters___type__3'),
          ]);
          const set = new Set<string>();
          for (const l of lists) for (const o of l) set.add(o);
          filterSizeOptions = Array.from(set).sort((a, b) =>
            a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
        } catch { filterSizeOptions = []; }
      }

      return res.status(200).json({
        inspection: data.inspection,
        propertyRecordId: data.propertyIdRef,
        propertySquareFootage: data.propertySquareFootage,
        propertyZip: data.propertyZip,
        propertyStatus: data.propertyStatus,
        // Pest/pet marks: frozen snapshot when completed, else live.
        propertyPestControlEnrolled: listingSnapshot ? !!listingSnapshot.pestControlEnrolled : data.propertyPestControlEnrolled,
        propertyTenantHasPet: listingSnapshot ? !!listingSnapshot.tenantHasPet : data.propertyTenantHasPet,
        propertyLastTenantMonths: data.propertyLastTenantMonths,
        propertyAirFiltersTotal: data.propertyAirFiltersTotal,
        propertyAirFiltersType1: data.propertyAirFiltersType1,
        propertyAirFiltersType2: data.propertyAirFiltersType2,
        propertyAirFiltersType3: data.propertyAirFiltersType3,
        propertySepticFee: data.propertySepticFee,
        listingPrice: listing?.listingPrice ?? null,
        listingDate: listing?.listingDate ?? null,
        listingStatus: listing?.listingStatus ?? null,
        moveInReadyDate: listing?.moveInReadyDate ?? null,
        moveInDate: listing?.moveInDate ?? null,
        communityName: communityName ?? null,
        filterSizeOptions,
        shareLinks,
        answers,
        // The Internal Resolution after-photo requirement is live only once the
        // after_photo_urls property exists (migration run). The client uses this
        // to gate its finalize block so it can't deadlock before the migration.
        afterPhotosEnabled: await answerHasAfterPhotoProperty(),
      });
    } catch (e: any) {
      console.error(`GET /api/inspections/${id} failed:`, e);
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const props = req.body?.properties || req.body || {};
      if (!props || typeof props !== 'object') {
        return res.status(400).json({ error: 'Missing properties' });
      }
      // Allowlist: this general PATCH endpoint may only set fields the client is
      // expected to send here (currently the section layout). Status/verdict and
      // other lifecycle fields have dedicated, guarded routes — don't let an
      // arbitrary property write through this surface.
      const ALLOWED_PATCH_FIELDS = new Set(['section_list_json']);
      const filtered: Record<string, any> = {};
      for (const k of Object.keys(props)) {
        if (ALLOWED_PATCH_FIELDS.has(k)) filtered[k] = props[k];
      }
      if (Object.keys(filtered).length === 0) {
        return res.status(400).json({ error: 'No editable properties in request' });
      }
      // Compare-and-swap for the section layout: if the client tells us the
      // value it believes is current (baseSectionListJson) and that no longer
      // matches what's stored, another tab/device changed it first — reject so
      // we don't clobber their edit (last-writer-wins data loss). The client
      // reloads on 409. Only enforced when the client opts in by sending a base.
      if ('section_list_json' in filtered && typeof req.body?.baseSectionListJson === 'string') {
        try {
          const current = await fetchInspectionById(id);
          const currentJson = current?.sectionListJson || '';
          if (currentJson !== req.body.baseSectionListJson) {
            return res.status(409).json({ error: 'conflict', currentSectionListJson: currentJson });
          }
        } catch (e) {
          // Fail-open: if we can't read the current value, proceed rather than
          // block a legitimate save.
          console.warn(`PATCH /api/inspections/${id} CAS read failed (continuing):`, e);
        }
      }
      await updateInspection(id, filtered);
      return res.status(200).json({ success: true });
    } catch (e: any) {
      console.error(`PATCH /api/inspections/${id} failed:`, e);
      return res.status(500).json({ error: 'Could not save changes. Please try again.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
