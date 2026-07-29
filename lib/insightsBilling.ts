/**
 * lib/insightsBilling.ts — SERVER-ONLY billing report data (Insights).
 *
 * Two report datasets, both filterable by region / portfolio / inspector (or
 * vendor) / completed-date range:
 *   • Inspections — one row per COMPLETED inspection. Billing columns come from
 *     the Agent object owned by the inspector (broker_code, inspection_vendor_cost,
 *     inspection_client_cost) + the linked Property (entity_id, portfolio).
 *     Defaults when a value is missing: Broker Code / Inspector → "Internal
 *     Employee", Vendor → $0, Client → $60.
 *   • Services — one row per COMPLETED service work order, using the service's
 *     own vendor/client cost fields.
 *
 * Inspection base rows come from the banked Insights snapshot (fast, no live
 * scan — rebuilt every 30 min by the cron); billing-specific columns are
 * enriched on demand (batched Property + Agent reads, both cached).
 */
import { readInsightsSnapshot, type InsightsSnapshot } from '@/lib/insightsSnapshot';
import { templateLabel } from '@/lib/templateLabels';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { fetchAgentBillingByEmails, fetchPropertyBillingByIds, fetchVendorCompanyCodesByEmails, searchServiceWorkOrdersByStatus, fetchCommunityMasterIdsByIds } from '@/lib/hubspot';

export const INTERNAL_EMPLOYEE = 'Internal Employee';   // inspections: no agent broker
export const INTERNAL_VENDOR = 'Internal Vendor';       // services: no company code
export const DEFAULT_CLIENT_COST = 60;   // when the agent has no inspection_client_cost
export const DEFAULT_VENDOR_COST = 0;    // when the agent has no inspection_vendor_cost

/** Inspection-style ID for a service: SVC-YYYY-MM-DD-<8hex derived from the
 *  record id> (mirrors INSP-2026-07-20-82f86ac0). */
function serviceExternalId(recordId: string, completedDate: string): string {
  let h = 0; for (const c of String(recordId)) h = (Math.imul(31, h) + c.charCodeAt(0)) >>> 0;
  const hex = (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(completedDate) ? completedDate : new Date().toISOString().slice(0, 10);
  return `SVC-${d}-${hex}`;
}

export interface BillingFilters {
  regions?: string[];      // region_snapshot values ("GA: Atlanta")
  portfolios?: string[];   // Property portfolio values (inspections/services)
  inspectors?: string[];   // inspector name OR vendor name (services)
  types?: string[];        // template/service type LABELS
  from?: string;           // completed on/after (YYYY-MM-DD, inclusive)
  to?: string;             // completed on/before (YYYY-MM-DD, inclusive)
}

/** A billing row — the same shape for inspections and services (the label of
 *  the "inspector" column differs per dataset, handled in the column defs). */
export interface BillingRow {
  externalId: string;
  entityId: string;
  fullAddress: string;
  propertyStatus: string;   // services: property status snapshotted at completion; '' for inspections
  personName: string;   // Inspector (inspections) / Vendor (services)
  brokerCode: string;
  typeLabel: string;    // Template Type / Service type
  vendorAmount: number;
  clientAmount: number;
  region: string;
  portfolio: string;
  completedDate: string;   // YYYY-MM-DD (internal; displayed as M-D-YY)
  dueDate: string;         // YYYY-MM-DD (services only; '' for inspections)
}

/** YYYY-MM-DD → M-D-YY (e.g. "2026-07-24" → "7-24-26"). '' passes through. */
function fmtMDY(iso: string | null | undefined): string {
  const s = String(iso || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}`;
}

const num = (v: unknown): number | null => {
  // Blank/absent → null (so the caller's default applies). Number('') is 0, which
  // would otherwise mask a missing value as a real $0.
  const s = String(v ?? '').replace(/[$,]/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const dateOnly = (iso: string | null | undefined): string => {
  const s = String(iso || '').trim(); if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const inRange = (day: string, from?: string, to?: string): boolean =>
  (!from || day >= from) && (!to || day <= to);
const has = (list: string[] | undefined, v: string): boolean =>
  !list || !list.length || list.includes(v);

/** Column headers, in order, for each dataset's table + xlsx. Cell values (see
 *  rowToCells) follow the SAME order for both datasets. */
export const INSPECTION_COLUMNS = [
  'External Inspection ID', 'Entity ID', 'Region', 'Portfolio', 'Full Address',
  'Template Type', 'Inspector Name', 'Broker Code', 'Completed Date', 'Vendor Invoice Amount', 'Client Invoice Amount',
] as const;
export const SERVICE_COLUMNS = [
  'Service ID', 'Entity / Master ID', 'Region', 'Portfolio', 'Full Address', 'Property Status',
  'Service Type', 'Vendor', 'Company Code', 'Completed Date', 'Due Date', 'Vendor Invoice Amount', 'Client Invoice Amount',
] as const;

export function rowToCells(r: BillingRow, object: 'inspections' | 'services' = 'inspections'): (string | number)[] {
  // Services carry a Property Status column (status at completion) right after
  // Full Address, and a Due Date column between Completed Date and the amounts.
  if (object === 'services') {
    return [
      r.externalId, r.entityId, r.region, r.portfolio, r.fullAddress, r.propertyStatus || '',
      r.typeLabel, r.personName, r.brokerCode, fmtMDY(r.completedDate), fmtMDY(r.dueDate),
      r.vendorAmount, r.clientAmount,
    ];
  }
  return [
    r.externalId, r.entityId, r.region, r.portfolio, r.fullAddress,
    r.typeLabel, r.personName, r.brokerCode, fmtMDY(r.completedDate),
    r.vendorAmount, r.clientAmount,
  ];
}

/** Inspections billing rows (completed only), filtered. `preSnap` lets the
 *  billing-snapshot builder pass the just-built Insights snapshot in-memory
 *  instead of re-reading the blob it just wrote. */
export async function fetchInspectionBillingRows(filters: BillingFilters = {}, preSnap?: InsightsSnapshot | null): Promise<BillingRow[]> {
  const snap = preSnap ?? await readInsightsSnapshot().catch(() => null);
  // Pre-filter on the CHEAP snapshot fields (completed-date range, inspector, type,
  // and region when the snapshot already carries one) BEFORE the per-row Property/
  // Agent enrichment — so a 7-day report only enriches those ~few rows instead of
  // every completed inspection ever. Portfolio (and region when it's only on the
  // Property) are still applied after enrichment in the loop below.
  const base = (snap?.rows || []).filter((r) => {
    if (r.status !== 'completed' || !r.completedAt) return false;
    if (!inRange(dateOnly(r.completedAt), filters.from, filters.to)) return false;
    if (!has(filters.inspectors, (r.inspectorName || '').trim() || INTERNAL_EMPLOYEE)) return false;
    if (!has(filters.types, templateLabel(r.templateType) || r.templateType)) return false;
    if (filters.regions?.length && r.region && !filters.regions.includes(r.region)) return false;
    return true;
  });

  // Enrich Property (entity_id + portfolio) and Agent billing (broker/costs).
  const propIds = base.map((r) => r.propertyId).filter((x): x is string => !!x);
  const emails = base.map((r) => r.inspectorEmail).filter(Boolean);
  const [propMap, agentMap] = await Promise.all([
    fetchPropertyBillingByIds(propIds),
    fetchAgentBillingByEmails(emails),
  ]);

  const rows: BillingRow[] = [];
  for (const r of base) {
    const prop = r.propertyId ? propMap.get(r.propertyId) : undefined;
    const agent = agentMap.get((r.inspectorEmail || '').trim().toLowerCase());
    const region = r.region || prop?.region || '';
    const portfolio = prop?.portfolio || '';
    const completedDate = dateOnly(r.completedAt);
    const inspectorName = (r.inspectorName || '').trim() || INTERNAL_EMPLOYEE;
    const vendorCost = num(agent?.vendorCost) ?? DEFAULT_VENDOR_COST;
    const clientCost = num(agent?.clientCost) ?? DEFAULT_CLIENT_COST;
    const brokerCode = (agent?.brokerCode || '').trim() || INTERNAL_EMPLOYEE;
    const typeLabel = templateLabel(r.templateType) || r.templateType;
    // Apply filters.
    if (!has(filters.regions, region) || !has(filters.portfolios, portfolio) || !has(filters.inspectors, inspectorName) || !has(filters.types, typeLabel)) continue;
    if (!inRange(completedDate, filters.from, filters.to)) continue;
    rows.push({
      externalId: r.inspectionIdExternal || r.recordId,
      entityId: prop?.entityId || '',
      fullAddress: r.propertyAddress || prop?.address || '',
      propertyStatus: '',   // services-only column
      personName: inspectorName,
      brokerCode,
      typeLabel,
      vendorAmount: vendorCost,
      clientAmount: clientCost,
      region, portfolio, completedDate, dueDate: '',
    });
  }
  rows.sort((a, b) => (b.completedDate).localeCompare(a.completedDate) || a.fullAddress.localeCompare(b.fullAddress));
  return rows;
}

/** Services billing rows (completed only), filtered. Uses the service work
 *  order's own vendor/client cost fields + linked Property for entity/portfolio.
 *  Broker Code defaults to Internal Employee (services aren't agent-billed). */
export async function fetchServiceBillingRows(filters: BillingFilters = {}): Promise<BillingRow[]> {
  // Narrow the scan to the completed window (when set) so a short report doesn't
  // page the entire completed-service history just to filter it down in the loop.
  const records = (await searchServiceWorkOrdersByStatus('completed', 5000, { completedFrom: filters.from, completedTo: filters.to }).catch(() => null)) || [];
  // Bill at the COMMUNITY MASTER level: keep community masters (total vendor/client
  // cost across the covered homes) + all standalone/property services, and DROP the
  // per-property split children (master_service_id set) — the old per-property
  // allocation is retired. Community rows show the community's master_id; property
  // rows show the property's entity_id.
  const kept = records.filter(({ props: p }) => !String(p.master_service_id || '').trim());
  const propIds = kept.map((x) => String(x.props.property_id_ref || '').trim()).filter(Boolean);
  const vendorEmails = kept.map((x) => String(x.props.vendor_email || '').trim()).filter(Boolean);
  const communityIds = [...new Set(kept.filter((x) => String(x.props.scope) === 'community').map((x) => String(x.props.community_id_ref || '').trim()).filter(Boolean))];
  const [propMap, codeMap, masterIdMap] = await Promise.all([
    fetchPropertyBillingByIds(propIds),
    fetchVendorCompanyCodesByEmails(vendorEmails),
    fetchCommunityMasterIdsByIds(communityIds),
  ]);

  const rows: BillingRow[] = [];
  for (const { id, props: p } of kept) {
    const isCommunity = String(p.scope) === 'community';
    const prop = p.property_id_ref ? propMap.get(String(p.property_id_ref)) : undefined;
    // Community coverage → community master_id; property coverage → property entity_id.
    const idValue = isCommunity ? (masterIdMap.get(String(p.community_id_ref || '').trim()) || '') : (prop?.entityId || '');
    const region = String(p.region_snapshot || prop?.region || '').trim();
    // Property coverage → live linked-Property portfolio; community coverage →
    // the portfolio snapshotted from an associated home at generation/backfill.
    const portfolio = String(prop?.portfolio || p.portfolio_snapshot || '').trim();
    const completedDate = dateOnly(p.completed_at);
    const dueDate = dateOnly(p.due_date);
    const vendorName = String(p.vendor_name || '').trim() || INTERNAL_VENDOR;
    const vendorCost = num(p.vendor_cost) ?? DEFAULT_VENDOR_COST;
    const clientCost = num(p.client_cost) ?? DEFAULT_CLIENT_COST;
    const companyCode = (codeMap.get(String(p.vendor_email || '').trim().toLowerCase()) || '').trim() || INTERNAL_VENDOR;
    const wt = String(p.worktype || '').trim();
    const st = String(p.subtype || '').trim();
    const typeLabel = [wt ? worktypeLabel(wt) : '', st ? subtypeLabel(wt, st) : ''].filter(Boolean).join(' · ');
    if (!has(filters.regions, region) || !has(filters.portfolios, portfolio) || !has(filters.inspectors, vendorName) || !has(filters.types, typeLabel)) continue;
    if (!inRange(completedDate, filters.from, filters.to)) continue;
    rows.push({
      externalId: serviceExternalId(id, completedDate),
      entityId: idValue,
      fullAddress: [String(p.address_snapshot || p.community_name || '').trim(), String(p.locality_snapshot || '').trim()].filter(Boolean).join(', '),
      // Property status snapshotted when the vendor submitted the completed work
      // (stamped at submit) — the status at completion. Bid items completed via the
      // "complete now" path skip that submit stamp, so fall back to the property's
      // current live status (from the batched Property read) rather than blank.
      propertyStatus: String(p.property_status_snapshot || '').trim() || (prop?.status || ''),
      personName: vendorName,
      brokerCode: companyCode,
      typeLabel,
      vendorAmount: vendorCost,
      clientAmount: clientCost,
      region, portfolio, completedDate, dueDate,
    });
  }
  rows.sort((a, b) => (b.completedDate).localeCompare(a.completedDate) || a.fullAddress.localeCompare(b.fullAddress));
  return rows;
}

export async function fetchBillingRows(object: 'inspections' | 'services', filters: BillingFilters = {}): Promise<BillingRow[]> {
  return object === 'services' ? fetchServiceBillingRows(filters) : fetchInspectionBillingRows(filters);
}

/** Filter-dropdown facets WITHOUT the heavy per-row enrichment. Inspections read
 *  region/inspector/type straight off the banked snapshot (portfolios come from the
 *  property catalog the API merges in). Services still derive from their one status
 *  scan. This replaces a second full, unfiltered fetchBillingRows pass. */
export async function billingFacetsFast(object: 'inspections' | 'services'): Promise<{ regions: string[]; portfolios: string[]; people: string[]; types: string[] }> {
  if (object === 'services') {
    // Vendor + type + region/portfolio options straight off the raw completed
    // records — NO per-row Property/vendor/community enrichment (that heavy pass
    // was the same cost as the rows fetch, run a second time just for dropdowns).
    // Region/portfolio dropdowns are additionally widened by the API from the
    // Property catalog, so property rows' live portfolio still appears.
    const records = (await searchServiceWorkOrdersByStatus('completed', 5000).catch(() => null)) || [];
    const regions = new Set<string>(); const portfolios = new Set<string>(); const people = new Set<string>(); const types = new Set<string>();
    for (const { props: p } of records) {
      if (String(p.master_service_id || '').trim()) continue;   // drop split children (mirror rows)
      const region = String(p.region_snapshot || '').trim(); if (region) regions.add(region);
      const portfolio = String(p.portfolio_snapshot || '').trim(); if (portfolio) portfolios.add(portfolio);
      people.add(String(p.vendor_name || '').trim() || INTERNAL_VENDOR);
      const wt = String(p.worktype || '').trim(); const st = String(p.subtype || '').trim();
      const typeLabel = [wt ? worktypeLabel(wt) : '', st ? subtypeLabel(wt, st) : ''].filter(Boolean).join(' · ');
      if (typeLabel) types.add(typeLabel);
    }
    const sort = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b));
    return { regions: sort(regions), portfolios: sort(portfolios), people: sort(people), types: sort(types) };
  }
  const snap = await readInsightsSnapshot().catch(() => null);
  const regions = new Set<string>(); const people = new Set<string>(); const types = new Set<string>();
  for (const r of (snap?.rows || [])) {
    if (r.status !== 'completed' || !r.completedAt) continue;
    if (r.region) regions.add(r.region);
    people.add((r.inspectorName || '').trim() || INTERNAL_EMPLOYEE);
    const t = templateLabel(r.templateType) || r.templateType; if (t) types.add(t);
  }
  const sort = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b));
  return { regions: sort(regions), portfolios: [], people: sort(people), types: sort(types) };
}
export function billingColumns(object: 'inspections' | 'services'): readonly string[] {
  return object === 'services' ? SERVICE_COLUMNS : INSPECTION_COLUMNS;
}
