import type { NextApiRequest, NextApiResponse } from 'next';
import { createScheduledInspection, fetchPropertyRegion, copyRateCardLinesToQc, fetchInspectionById, populateBillingFields, updateInspection, recomputeInspectionTotals, fetchActiveUsers, fetchPropertyStatus, bustExternalUnlockedView, findInspectionIdByExternalId, associateCommunityToInspection, resolveCommunityDisplay, formatCommunityLocation } from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';
import { bustInspectionsCache } from '@/pages/api/inspections';
import { inspectionUrl, reqOriginOf } from '@/lib/appUrl';
import { externalAccessDenial, isExternalEmail, EXTERNAL_TEMPLATE, externalCanCreate1099ForStatus, EXTERNAL_1099_STATUS_BLOCK_MSG } from '@/lib/userAccess';
import { inspectionsEnabled, inspectionAccessLevel } from '@/lib/userManagement';
import { vendorInspectionLevel } from '@/lib/inspectionGuard';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { getCachedRegions } from '@/pages/api/rate-card/regions';
import { recordErrorEvent } from '@/lib/errorLog';
import { resolveCoords } from '@/lib/geocodeResolve';

function nowIso(): string {
  return new Date().toISOString();
}

/** Fallback title-case for any template type not in the explicit prefix map:
 *  "some_new_template" -> "Some New Template". */
function properCase(templateType: string): string {
  return templateType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortId(): string {
  // crypto.randomUUID (Node 18+) for collision-proof ids; strip dashes.
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
    return (crypto as any).randomUUID().replace(/-/g, '');
  }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

interface CreateBody {
  templateType: string;
  propertyRecordId?: string;
  propertyAddressSnapshot?: string;
  inspectorName: string;
  inspectorEmail?: string;
  bedrooms?: number;
  bathrooms?: number;
  // Community / Visit: a Community replaces the property (+ bed/bath). We snapshot
  // the community NAME as the address and store its record id in property_id_ref.
  communityRecordId?: string;
  communityName?: string;
  // Optional: when the user uses "Schedule Inspection", they pick a specific date.
  // ISO date string (YYYY-MM-DD) or full ISO datetime. If absent, defaults to now.
  scheduledDate?: string;
  // QC Turn Re-Inspect: the source Scope Rate Card inspection to validate.
  sourceRateCardId?: string;
  // Offline-started ("deferred create") inspections generate their own external
  // id on the device so queued answer/photo idempotency keys are stable. When
  // present we create the record with THIS id (and dedupe on it for retries).
  externalId?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const body = req.body as CreateBody;
    if (!body || !body.templateType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // Community / Visit inspections carry a community instead of a property.
    const isCommunity = body.templateType === 'pm_community_inspection';
    if (isCommunity ? !body.communityRecordId : !body.propertyRecordId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // The subject shown where the address normally is: community name, else the
    // property address snapshot. The inspection NAME uses the bare community name.
    const subjectLabel = isCommunity ? (body.communityName || 'Community') : (body.propertyAddressSnapshot || '');
    // Community / Visit: bake "<Community>, City, State ZIP" into the address
    // snapshot so the list card shows the City/State/ZIP line like a property
    // does. Location comes from the Community object's own fields, or — when
    // those are blank — the first associated property's (resolved server-side).
    let addressSnapshot = subjectLabel;
    // Community region for region_snapshot: the Community object's own region, or
    // the first associated property's region (resolved together with location).
    let communityRegion = '';
    if (isCommunity && body.communityRecordId) {
      try {
        const cd = await resolveCommunityDisplay(body.communityRecordId);
        const cName = cd?.name || body.communityName || 'Community';
        const cLoc = formatCommunityLocation(cd);
        addressSnapshot = cLoc ? `${cName}, ${cLoc}` : cName;
        communityRegion = (cd?.region || '').trim();
      } catch { /* fall back to the bare name */ }
    }

    // External (1099) users may only create the 1099 template. This is a NEW
    // record with no owner yet — the creator WILL own it (inspector_email is
    // stamped to session.email below), so pass ownerEmail: session.email. Without
    // it the write gate's fail-closed-on-blank-owner rule (which correctly blocks
    // an external user from editing an UNASSIGNED existing inspection) would also
    // block them from starting their own — the "can only edit your own" error.
    // Tri-state level for externals: FULL creates any template like an internal
    // user; NONE is blocked; LIMITED keeps the classic 1099-template rule.
    const extLevel = isExternalEmail(session.email)
      ? ((await vendorInspectionLevel(session.email).catch(() => null))
        ?? await inspectionAccessLevel(session.email).catch(() => 'limited' as const))
      : null;
    if (extLevel === 'none') {
      return res.status(403).json({ error: 'Your account does not have Inspections access.' });
    }
    if (extLevel !== 'full') {
      const denial = externalAccessDenial(session.email, body.templateType, { write: true, ownerEmail: session.email });
      if (denial) {
        void recordErrorEvent({ kind: 'inspection_start', message: denial, email: session.email, template: body.templateType, source: 'server' });
        return res.status(403).json({ error: denial });
      }
    }
    // Internal Inspections access (User Management). External 1099 users keep their
    // own path above; internal users default to enabled unless an admin toggled it
    // off — so this only blocks someone explicitly set to Inspections = None.
    if (!isExternalEmail(session.email) && !(await inspectionsEnabled(session.email).catch(() => true))) {
      return res.status(403).json({ error: 'Your access to Inspections has been turned off. Contact an admin.' });
    }

    // External 1099 walks are only allowed once the property is in a leasing
    // status (Vacant - Pre-Leasing / On Market) — the Turn must be done first.
    if (isExternalEmail(session.email) && body.templateType === EXTERNAL_TEMPLATE) {
      const status = await fetchPropertyStatus(body.propertyRecordId || '');
      if (!externalCanCreate1099ForStatus(status)) {
        void recordErrorEvent({ kind: 'inspection_start', message: EXTERNAL_1099_STATUS_BLOCK_MSG, email: session.email, template: body.templateType, source: 'server', meta: { propertyStatus: status || '(blank)', propertyId: body.propertyRecordId } });
        return res.status(403).json({ error: EXTERNAL_1099_STATUS_BLOCK_MSG });
      }
    }

    // Use the client-supplied external id for an offline-started inspection (so
    // its already-queued answer/photo keys match), else mint one. IDEMPOTENCY:
    // if a record with this external id already exists, a retried deferred create
    // would otherwise duplicate it — return the existing record instead.
    const externalId = (typeof body.externalId === 'string' && /^INSP-/.test(body.externalId))
      ? body.externalId
      : `INSP-${nowIso().slice(0, 10)}-${shortId().slice(0, 8)}`;
    if (typeof body.externalId === 'string' && body.externalId) {
      const existingId = await findInspectionIdByExternalId(externalId);
      if (existingId) {
        return res.status(200).json({ success: true, inspectionId: existingId, externalId, deduped: true });
      }
    }

    // Inspection name format: Rate Card inspections use "Rate Card – <address> – <date>"
    // per the Phase 1 Q-M decision; others use a proper-cased template label
    // prefix (matching the labels shown in the UI) so names read cleanly on the
    // HubSpot record instead of "leasing agent 1099 property inspection".
    const isRateCard = body.templateType === 'pm_scope_rate_card';
    const isQc = body.templateType === 'pm_turn_reinspect_qc';
    const TEMPLATE_NAME_PREFIX: Record<string, string> = {
      pm_community_inspection: 'Community / Visit Inspection',
      pm_vacancy_occupancy_check: 'Vacancy / Occupancy Check',
      qc_new_construction_rrqc: 'New Construction RRQC',
      leasing_agent_1099_property_inspection: '1099 Leasing Agent Inspection',
    };
    const today = nowIso().slice(0, 10);
    // Resolve a clean label for an admin-created custom template (id like
    // custom_x_ab12) so the inspection name reads nicely.
    let customLabel = '';
    if (!isRateCard && !isQc && !TEMPLATE_NAME_PREFIX[body.templateType]) {
      try {
        const { getCustomTemplates } = await import('@/lib/formTemplates');
        customLabel = (await getCustomTemplates()).find((t) => t.id === body.templateType)?.label || '';
      } catch { /* fall back to prettified id */ }
    }
    const inspectionName = isRateCard
      ? `Rate Card – ${subjectLabel} – ${today}`
      : isQc
        ? `Turn Re-Inspect QC – ${subjectLabel} – ${today}`
        : `${TEMPLATE_NAME_PREFIX[body.templateType] || customLabel || properCase(body.templateType)} – ${subjectLabel} – ${today}`;

    // HubSpot's scheduled_date is a Date field (not DateTime), so the value MUST be
    // exactly midnight UTC. We send the YYYY-MM-DD string form, which HubSpot interprets
    // as midnight UTC of that calendar day.
    //
    // - If body.scheduledDate is YYYY-MM-DD (from <input type="date">), use it directly.
    // - If it's a full ISO string, extract the YYYY-MM-DD portion (the user's local date).
    // - If absent, use today's date in UTC.
    let scheduledDateValue: string;
    if (body.scheduledDate) {
      // Scheduled is a plain calendar date. Take the leading YYYY-MM-DD exactly
      // as written — do NOT reparse a full ISO string through Date(), which
      // converts to UTC and rolls the day forward for users in negative-offset
      // timezones (e.g. an 8pm ET pick would become the next day).
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(body.scheduledDate));
      scheduledDateValue = m ? m[1] : nowIso().slice(0, 10);
    } else {
      scheduledDateValue = nowIso().slice(0, 10);
    }

    // Stamp external (1099) creators as the owner so the ownership guard can
    // reliably restrict edit/cancel to their own inspections. Internal users
    // keep the client-provided value (they may create on behalf of others).
    const inspectorEmail = isExternalEmail(session.email) ? session.email : (body.inspectorEmail || '');

    // Resolve the inspector's DISPLAY NAME server-side from the latest user data
    // (matched by email) so we never persist the email-username fallback
    // ("asanders") the client may hold if its /me name wasn't repaired yet. Only
    // staff users are in this list; for a 1099 (external) inspector with no match
    // we keep the client-provided value. Best-effort — never blocks creation.
    let inspectorName = body.inspectorName;
    try {
      const want = inspectorEmail.trim().toLowerCase();
      if (want) {
        const match = (await fetchActiveUsers()).find((u) => (u.email || '').trim().toLowerCase() === want);
        // fullName falls back to the email username when the owner record has no
        // name; only override when we got a real (non-email) name.
        if (match?.fullName && !match.fullName.includes('@') && match.fullName !== want.split('@')[0]) {
          inspectorName = match.fullName;
        }
      }
    } catch (e) {
      console.warn('[create] inspector name resolve failed; using client value:', e);
    }

    // Seed the sortable property-status snapshot from the property's current
    // status so a brand-new inspection is sortable by status immediately (the
    // home list's enrichment keeps it fresh thereafter). Best-effort — null if
    // the property has no status or the read fails.
    const propertyStatusSnapshot = isCommunity ? null : await fetchPropertyStatus(body.propertyRecordId || '');

    const inspectionProps: Record<string, any> = {
      inspection_id_external: externalId,
      inspection_name: inspectionName,
      template_type: body.templateType,
      status: 'scheduled',
      property_address_snapshot: addressSnapshot,
      inspector_name: inspectorName,
      inspector_email: inspectorEmail,
      // Community/Visit stores the community record id here (no property);
      // otherwise the property id.
      property_id_ref: isCommunity ? body.communityRecordId : body.propertyRecordId,
      scheduled_date: scheduledDateValue,
      // Bed/bath only apply to a unit — omit for community.
      ...(isCommunity ? {} : { bedrooms_at_inspection: body.bedrooms, bathrooms_at_inspection: body.bathrooms }),
      // Community has no property to copy full_address from (billing sync fills it
      // for property inspections), so set it here to "<Community>, City, St, Zip".
      ...(isCommunity ? { full_address: addressSnapshot } : {}),
      ...(propertyStatusSnapshot ? { property_status_snapshot: propertyStatusSnapshot } : {}),
    };

    // Snapshot the property's `region` onto the new inspection's `region_snapshot`
    // for EVERY template — region is a property attribute, so 1099 / Vacancy /
    // Community inspections need it too (otherwise they're invisible under the
    // region filter and their inspectors don't surface when filtering by region).
    // The math layer falls back to GA:Atlanta if region is missing/unmatched.
    if (isCommunity) {
      // Community region resolved above (community's own region, else the first
      // associated property's). Stamp it so community inspections are filterable
      // by region like every other template.
      if (communityRegion) inspectionProps.region_snapshot = communityRegion;
    } else {
      try {
        const region = await fetchPropertyRegion(body.propertyRecordId || '');
        if (region) {
          inspectionProps.region_snapshot = region;
        }
      } catch (e) {
        // Don't block inspection creation if region lookup fails; log and continue.
        console.warn(`Region lookup failed for property ${body.propertyRecordId}; using fallback.`, e);
      }
    }

    // QC Turn Re-Inspect: stamp the source inspection ref + carry its region
    // snapshot so the copied lines price/display consistently. The source is now
    // OPTIONAL — a QC can be started standalone (no recent Scope) and the form
    // renders empty rooms for after-photos + a final pass/fail.
    if (isQc && body.sourceRateCardId) {
      inspectionProps.source_rate_card_id = body.sourceRateCardId;
      try {
        const src = await fetchInspectionById(body.sourceRateCardId);
        if (src) {
          inspectionProps.source_rate_card_name = src.inspectionName || '';
          if (src.regionSnapshot) inspectionProps.region_snapshot = src.regionSnapshot;
        }
      } catch (e) {
        console.warn(`Could not load source inspection ${body.sourceRateCardId}:`, e);
      }
    }

    const { inspectionId } = await createScheduledInspection({
      inspectionProps,
      // No property for a community inspection — the property association is
      // simply skipped (fail-open); the Community association is created below.
      propertyRecordId: body.propertyRecordId || '',
    });

    // Community / Visit: associate the chosen Community object to this inspection
    // (best-effort — the inspection is already created).
    if (isCommunity && body.communityRecordId) {
      await associateCommunityToInspection(inspectionId, body.communityRecordId);
    }

    // Seed the combined-date sort key: initialize last_edited_at to the scheduled
    // date so a brand-new (unedited) scheduled inspection sorts by its scheduled
    // date. The first real edit bumps it to the edit time (touchInspection), so
    // the single "Date" sort reads as "updated date, falling back to scheduled".
    // Best-effort — swallow if the property isn't created in this portal yet.
    try {
      await updateInspection(inspectionId, {
        last_edited_at: new Date(`${scheduledDateValue}T12:00:00.000Z`).toISOString(),
      });
    } catch { /* last_edited_at absent → hs_lastmodifieddate fallback + backfill cover it */ }

    // QC: copy the source Rate Card's line items onto the new QC inspection so
    // it's a self-contained snapshot. Done after creation so we have the new id.
    let copiedLines = 0;
    if (isQc && body.sourceRateCardId) {
      try {
        copiedLines = await copyRateCardLinesToQc({
          sourceInspectionId: body.sourceRateCardId,
          qcInspectionId: inspectionId,
        });
      } catch (e) {
        console.error(`QC line copy failed for inspection ${inspectionId}:`, e);
        // Don't fail the create — the QC exists; the form will just show no
        // lines and the user can retry/reopen. Surface a soft warning.
      }
      // Stamp the QC's own cost rollups from the copied lines so its
      // `total_client_cost` reflects the source scope's value. This is what the
      // home list shows as "Client: $x" AND what the price sort orders on, so a
      // re-inspect now sorts by the scope it re-inspects instead of $0.
      // Best-effort — never blocks creation.
      if (copiedLines > 0) {
        try {
          const [catalog, regions] = await Promise.all([getCachedCatalog(), getCachedRegions()]);
          await recomputeInspectionTotals(inspectionId, { catalog, regions });
        } catch (e) {
          console.warn(`[create] QC totals recompute failed for ${inspectionId}:`, e);
        }
      }
    }

    // Stamp reference coordinates so the calendar map can plot this inspection
    // without a live geocode. Resolves via the property's stored coords/address
    // (community via its first property), validated against the address state.
    // Best-effort + guarded: a miss or absent latitude/longitude property just
    // leaves it to the map's client-side geocoding fallback.
    try {
      const c = await resolveCoords({ address: addressSnapshot, propertyId: (isCommunity ? body.communityRecordId : body.propertyRecordId) || '' });
      if (c) await updateInspection(inspectionId, { latitude: c.lat, longitude: c.lng });
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (!(msg.includes('PROPERTY_DOESNT_EXIST') || (msg.includes('Property') && msg.includes('does not exist')))) {
        console.warn(`[create] coordinate stamp skipped for ${inspectionId}:`, msg);
      }
    }

    // Stamp the live deep link onto the inspection so HubSpot has a one-tap URL
    // to open it. Needs the new record id, so it's a post-create update.
    // Best-effort: never block creation if the property is missing.
    try {
      await updateInspection(inspectionId, { resiwalk_inspection_url: inspectionUrl(inspectionId, reqOriginOf(req)) });
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (!(msg.includes('PROPERTY_DOESNT_EXIST') || (msg.includes('Property') && msg.includes('does not exist')))) {
        console.warn(`[create] resiwalk_inspection_url write failed for ${inspectionId}:`, msg);
      }
    }

    await bustInspectionsCache(); // show the new inspection in the list immediately
    // Starting an inspection can unlock a new state's view-only Scope/QC for an
    // external creator — drop their cached unlock so it recomputes next load.
    if (isExternalEmail(session.email)) bustExternalUnlockedView(session.email);

    // Billing sync: copy entity_id/full_address (property) + broker_code +
    // vendor/client invoice (agent owned by the inspector's owner) onto the new
    // inspection so billing reports are clean from the start. Best-effort —
    // never blocks creation. No-op if the billing properties don't exist yet.
    try {
      const billing = await populateBillingFields(inspectionId);
      if (!billing.ok) console.warn(`[create] billing populate note for ${inspectionId}: ${billing.note}`);
    } catch (e) {
      console.warn(`[create] billing populate failed for ${inspectionId} (continuing):`, e);
    }

    return res.status(200).json({ success: true, inspectionId, externalId, inspectionName, copiedLines });
  } catch (e: any) {
    console.error('POST /api/inspections/create failed:', e);
    // Capture the RAW HubSpot detail (e.detail from hubspotFetch) so the admin
    // error log shows WHICH property/association a 400 actually failed on — the
    // sanitized "Upstream request failed (400)" alone can't be diagnosed.
    void recordErrorEvent({
      kind: 'inspection_start', message: String(e?.message || e),
      email: session.email, template: (req.body as CreateBody)?.templateType, source: 'server',
      meta: { detail: String(e?.detail || '').slice(0, 600), status: e?.status ?? null, propertyId: (req.body as CreateBody)?.propertyRecordId || (req.body as CreateBody)?.communityRecordId || null },
    });
    return res.status(500).json({ error: String(e.message || e) });
  }
}
