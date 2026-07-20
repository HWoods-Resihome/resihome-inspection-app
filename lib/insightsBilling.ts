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
import { readInsightsSnapshot } from '@/lib/insightsSnapshot';
import { templateLabel } from '@/lib/templateLabels';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { fetchAgentBillingByEmails, fetchPropertyBillingByIds, fetchVendorCompanyCodesByEmails, searchServiceWorkOrdersByStatus } from '@/lib/hubspot';

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
  personName: string;   // Inspector (inspections) / Vendor (services)
  brokerCode: string;
  typeLabel: string;    // Template Type / Service type
  vendorAmount: number;
  clientAmount: number;
  region: string;
  portfolio: string;
  completedDate: string;   // YYYY-MM-DD
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
  'Service ID', 'Entity ID', 'Region', 'Portfolio', 'Full Address',
  'Service Type', 'Vendor', 'Company Code', 'Completed Date', 'Vendor Invoice Amount', 'Client Invoice Amount',
] as const;

export function rowToCells(r: BillingRow): (string | number)[] {
  return [
    r.externalId, r.entityId, r.region, r.portfolio, r.fullAddress,
    r.typeLabel, r.personName, r.brokerCode, r.completedDate, r.vendorAmount, r.clientAmount,
  ];
}

/** Distinct filter option values across a row set (for the UI dropdowns). */
export function billingFacets(rows: BillingRow[]): { regions: string[]; portfolios: string[]; people: string[]; types: string[] } {
  const regions = new Set<string>(); const portfolios = new Set<string>(); const people = new Set<string>(); const types = new Set<string>();
  for (const r of rows) { if (r.region) regions.add(r.region); if (r.portfolio) portfolios.add(r.portfolio); if (r.personName) people.add(r.personName); if (r.typeLabel) types.add(r.typeLabel); }
  const sort = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b));
  return { regions: sort(regions), portfolios: sort(portfolios), people: sort(people), types: sort(types) };
}

/** Inspections billing rows (completed only), filtered. */
export async function fetchInspectionBillingRows(filters: BillingFilters = {}): Promise<BillingRow[]> {
  const snap = await readInsightsSnapshot().catch(() => null);
  const base = (snap?.rows || []).filter((r) => r.status === 'completed' && r.completedAt);

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
      personName: inspectorName,
      brokerCode,
      typeLabel,
      vendorAmount: vendorCost,
      clientAmount: clientCost,
      region, portfolio, completedDate,
    });
  }
  rows.sort((a, b) => (b.completedDate).localeCompare(a.completedDate) || a.fullAddress.localeCompare(b.fullAddress));
  return rows;
}

/** Services billing rows (completed only), filtered. Uses the service work
 *  order's own vendor/client cost fields + linked Property for entity/portfolio.
 *  Broker Code defaults to Internal Employee (services aren't agent-billed). */
export async function fetchServiceBillingRows(filters: BillingFilters = {}): Promise<BillingRow[]> {
  const records = (await searchServiceWorkOrdersByStatus('completed', 5000).catch(() => null)) || [];
  const propIds = records.map((x) => String(x.props.property_id_ref || '').trim()).filter(Boolean);
  const vendorEmails = records.map((x) => String(x.props.vendor_email || '').trim()).filter(Boolean);
  const [propMap, codeMap] = await Promise.all([
    fetchPropertyBillingByIds(propIds),
    fetchVendorCompanyCodesByEmails(vendorEmails),
  ]);

  const rows: BillingRow[] = [];
  for (const { id, props: p } of records) {
    // Bill at the PROPERTY level: exclude the community grass-cut MASTER (it
    // carries covered_property_ids / a covered count and represents many homes)
    // and keep its per-property billing-line children (master_service_id set) +
    // all standalone services. This is the inverse of the vendor-performance
    // roll-up, which counts the master and drops the children.
    const coveredCount = Number(String(p.covered_property_count ?? '').trim());
    const isCommunityMaster = (Number.isFinite(coveredCount) && coveredCount > 0) || String(p.covered_property_ids || '').trim().length > 2;
    if (isCommunityMaster) continue;
    const prop = p.property_id_ref ? propMap.get(String(p.property_id_ref)) : undefined;
    const region = String(p.region_snapshot || prop?.region || '').trim();
    const portfolio = prop?.portfolio || '';
    const completedDate = dateOnly(p.completed_at);
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
      entityId: prop?.entityId || '',
      fullAddress: [String(p.address_snapshot || p.community_name || '').trim(), String(p.locality_snapshot || '').trim()].filter(Boolean).join(', '),
      personName: vendorName,
      brokerCode: companyCode,
      typeLabel,
      vendorAmount: vendorCost,
      clientAmount: clientCost,
      region, portfolio, completedDate,
    });
  }
  rows.sort((a, b) => (b.completedDate).localeCompare(a.completedDate) || a.fullAddress.localeCompare(b.fullAddress));
  return rows;
}

export async function fetchBillingRows(object: 'inspections' | 'services', filters: BillingFilters = {}): Promise<BillingRow[]> {
  return object === 'services' ? fetchServiceBillingRows(filters) : fetchInspectionBillingRows(filters);
}
export function billingColumns(object: 'inspections' | 'services'): readonly string[] {
  return object === 'services' ? SERVICE_COLUMNS : INSPECTION_COLUMNS;
}
