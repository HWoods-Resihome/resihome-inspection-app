/**
 * lib/insightsBillingSnapshot.ts — durable, precomputed billing dataset.
 *
 * The billing report used to do ALL its HubSpot work on the request: scan every
 * completed record, enrich each row (Property / Agent / vendor-code / community),
 * and scan the Property catalog for the filter dropdowns — 15-20s per load.
 *
 * Instead we bank the FULLY-ENRICHED, UNFILTERED row set for both datasets (plus
 * the region/portfolio filter catalog) to Vercel Blob on the same 30-min cadence
 * as the Insights snapshot (see /api/insights/rebuild). The request then reads the
 * blob and does all filtering / sorting / faceting IN MEMORY — no live HubSpot —
 * so the table renders effectively instantly. Billing is retrospective, so ≤30-min
 * freshness is the right trade; the API falls back to a live compute when the
 * snapshot hasn't been built yet.
 */
import { put, list } from '@vercel/blob';
import {
  fetchInspectionBillingRows, fetchServiceBillingRows,
  type BillingRow, type BillingFilters,
} from '@/lib/insightsBilling';
import { fetchRegionEnumOptions, fetchPortfolioEnumOptions, fetchPropertyCoverage } from '@/lib/hubspot';
import type { InsightsSnapshot } from '@/lib/insightsSnapshot';

export const BILLING_SNAPSHOT_BLOB_PATH = 'insights/billing-snapshot.json';

export interface BillingFacets { regions: string[]; portfolios: string[]; people: string[]; types: string[] }

export interface BillingSnapshot {
  asOf: string;                 // ISO build time
  buildMs: number;
  inspections: BillingRow[];    // ALL completed inspection billing rows (unfiltered)
  services: BillingRow[];       // ALL completed service billing rows (unfiltered)
  facets: { inspections: BillingFacets; services: BillingFacets };
}

const dateOnly = (iso: string | null | undefined): string => {
  const s = String(iso || '').trim(); if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const has = (list: string[] | undefined, v: string): boolean => !list || !list.length || list.includes(v);
const inRange = (day: string, from?: string, to?: string): boolean => (!from || day >= from) && (!to || day <= to);

/** Apply the report filters to a banked row set (in memory). The banked rows
 *  already carry the finished region/portfolio/person/type/date values, so this
 *  reproduces the live-filtered result exactly. */
export function filterBillingRows(rows: BillingRow[], filters: BillingFilters = {}): BillingRow[] {
  return rows.filter((r) =>
    has(filters.regions, r.region) &&
    has(filters.portfolios, r.portfolio) &&
    has(filters.inspectors, r.personName) &&
    has(filters.types, r.typeLabel) &&
    inRange(dateOnly(r.completedDate), filters.from, filters.to));
}

/** Distinct dropdown values from a row set, with region/portfolio widened by the
 *  full Property catalog so an admin can filter on one with no completed record yet. */
function facetsFrom(rows: BillingRow[], catRegions: string[], catPortfolios: string[]): BillingFacets {
  const regions = new Set<string>(catRegions); const portfolios = new Set<string>(catPortfolios);
  const people = new Set<string>(); const types = new Set<string>();
  for (const r of rows) {
    if (r.region) regions.add(r.region);
    if (r.portfolio) portfolios.add(r.portfolio);
    if (r.personName) people.add(r.personName);
    if (r.typeLabel) types.add(r.typeLabel);
  }
  const sort = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b));
  return { regions: sort(regions), portfolios: sort(portfolios), people: sort(people), types: sort(types) };
}

/** The region/portfolio catalog for the dropdowns — one enum-option call each
 *  (cached), falling back to the Property-list scan only if a field isn't an enum. */
async function filterCatalog(): Promise<{ regions: string[]; portfolios: string[] }> {
  const [regionEnum, portfolioEnum] = await Promise.all([
    fetchRegionEnumOptions().catch(() => null),
    fetchPortfolioEnumOptions().catch(() => null),
  ]);
  let regions = regionEnum; let portfolios = portfolioEnum;
  if (!regions || !portfolios) {
    const cov = await fetchPropertyCoverage().catch(() => null);
    if (cov) {
      if (!regions) regions = (cov.regions || []).map((r: any) => (typeof r === 'string' ? r : r.key)).filter(Boolean);
      if (!portfolios) portfolios = (cov.portfolios || []).map((p: any) => (typeof p === 'string' ? p : p.key)).filter(Boolean);
    }
  }
  return { regions: regions || [], portfolios: portfolios || [] };
}

/** Build the full billing snapshot (both datasets + facets). `insightsSnap` lets
 *  the caller reuse an in-memory Insights snapshot instead of re-reading the blob. */
export async function buildBillingSnapshot(insightsSnap?: InsightsSnapshot | null): Promise<BillingSnapshot> {
  const t0 = Date.now();
  const [inspections, services, catalog] = await Promise.all([
    fetchInspectionBillingRows({}, insightsSnap),
    fetchServiceBillingRows({}),
    filterCatalog(),
  ]);
  return {
    asOf: new Date().toISOString(),
    buildMs: Date.now() - t0,
    inspections,
    services,
    facets: {
      inspections: facetsFrom(inspections, catalog.regions, catalog.portfolios),
      services: facetsFrom(services, catalog.regions, catalog.portfolios),
    },
  };
}

export async function writeBillingSnapshot(snap: BillingSnapshot): Promise<void> {
  await put(BILLING_SNAPSHOT_BLOB_PATH, JSON.stringify(snap), {
    access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false,
  });
}

/** Read the latest billing snapshot, or null if none built yet. */
export async function readBillingSnapshot(): Promise<BillingSnapshot | null> {
  try {
    const { blobs } = await list({ prefix: BILLING_SNAPSHOT_BLOB_PATH, limit: 1 });
    const blob = blobs.find((b) => b.pathname === BILLING_SNAPSHOT_BLOB_PATH) || blobs[0];
    if (!blob) return null;
    const url = blob.url + (blob.uploadedAt ? `?t=${new Date(blob.uploadedAt).getTime()}` : '');
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as BillingSnapshot;
  } catch (e) {
    console.warn('[billing-snapshot] read failed:', e);
    return null;
  }
}
