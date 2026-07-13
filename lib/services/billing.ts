/**
 * ResiWalk - Services — billing (RECURRING_SERVICES_PLAN.md, P4).
 *
 * Billable = a COMPLETED Service Work Order that is NOT a split community master.
 * A community grass-cut master flips `for_billing` to 'false' when it splits into
 * per-property children, so filtering out for_billing='false' counts each cut once:
 * regular property jobs (no flag) and the per-property children (flag 'true') are
 * billed; the parent master is not. Lines are grouped by vendor for the pay period.
 */
import { searchServiceWorkOrdersByStatus, communityLocalityByName } from '@/lib/hubspot';
import { worktypeLabel, subtypeLabel } from './worktypes';

export interface BillingLine {
  id: string;
  completedAt: string;    // ISO date (YYYY-MM-DD)
  vendor: string;
  scope: 'property' | 'community';
  community: string;
  address: string;
  locality: string;
  worktype: string;
  subtype: string;
  worktypeLabel: string;
  subtypeLabel: string;
  vendorCost: number;
  clientCost: number;
  reviewDecision: string;
  fromMaster: boolean;    // this line is a per-property child split from a community master
}

export interface VendorGroup { vendor: string; lines: BillingLine[]; vendorTotal: number; clientTotal: number }
export interface BillingReport {
  configured: boolean;
  from: string; to: string;
  groups: VendorGroup[];
  vendorTotal: number; clientTotal: number; count: number;
}

const toISODate = (v: any): string => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{10,}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  return s.slice(0, 10);
};

/**
 * Billable completed lines whose completion date falls in [fromISO, toISO]
 * (inclusive). Empty range bounds are treated as open-ended. Returns null when
 * the Service object isn't configured. Grouped by vendor, alphabetical, with
 * per-vendor and grand totals.
 */
export async function buildBillingReport(fromISO: string, toISO: string): Promise<BillingReport | null> {
  const rows = await searchServiceWorkOrdersByStatus('completed', 5000);
  if (rows === null) return null;

  const from = (fromISO || '').slice(0, 10);
  const to = (toISO || '').slice(0, 10);
  const inRange = (d: string) => (!from || d >= from) && (!to || d <= to);

  const lines: BillingLine[] = [];
  for (const { id, props: p } of rows) {
    if (p.for_billing === 'false') continue;              // a split master — its children carry billing
    const completedAt = toISODate(p.completed_at);
    if (!inRange(completedAt)) continue;
    const wt = String(p.worktype || '');
    const st = String(p.subtype || '');
    lines.push({
      id,
      completedAt,
      vendor: String(p.vendor_name || '').trim() || '(Unassigned)',
      scope: p.scope === 'community' ? 'community' : 'property',
      community: String(p.community_name || '').trim(),
      address: String(p.address_snapshot || p.service_name || '').trim(),
      locality: String(p.locality_snapshot || '').trim(),
      worktype: wt, subtype: st,
      worktypeLabel: worktypeLabel(wt), subtypeLabel: subtypeLabel(wt, st),
      vendorCost: Math.round((Number(p.vendor_cost) || 0) * 100) / 100,
      clientCost: Math.round((Number(p.client_cost) || 0) * 100) / 100,
      reviewDecision: String(p.review_decision || '').trim(),
      fromMaster: !!String(p.master_service_id || '').trim(),
    });
  }

  // Fill community-scope localities from the community name map (masters carry
  // only the name). Best-effort; skip on failure.
  if (lines.some((l) => l.scope === 'community' && !l.locality && l.community)) {
    const byName = await communityLocalityByName().catch(() => new Map<string, string>());
    for (const l of lines) if (l.scope === 'community' && !l.locality && l.community) l.locality = byName.get(l.community) || '';
  }

  const byVendor = new Map<string, BillingLine[]>();
  for (const l of lines) { const arr = byVendor.get(l.vendor) || []; arr.push(l); byVendor.set(l.vendor, arr); }
  const groups: VendorGroup[] = [...byVendor.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([vendor, ls]) => {
      ls.sort((a, b) => (a.completedAt.localeCompare(b.completedAt)) || a.address.localeCompare(b.address));
      const vendorTotal = Math.round(ls.reduce((s, l) => s + l.vendorCost, 0) * 100) / 100;
      const clientTotal = Math.round(ls.reduce((s, l) => s + l.clientCost, 0) * 100) / 100;
      return { vendor, lines: ls, vendorTotal, clientTotal };
    });

  const vendorTotal = Math.round(groups.reduce((s, g) => s + g.vendorTotal, 0) * 100) / 100;
  const clientTotal = Math.round(groups.reduce((s, g) => s + g.clientTotal, 0) * 100) / 100;
  return { configured: true, from, to, groups, vendorTotal, clientTotal, count: lines.length };
}

// Flat, export-ready columns (CSV + xlsx share this).
export const BILLING_COLUMNS = [
  'Completed', 'Vendor', 'Work Type', 'Subtype', 'Scope', 'Community', 'Address', 'Locality',
  'Vendor Cost', 'Client Cost', 'Review', 'From Community Master',
] as const;

export function billingLineToRow(l: BillingLine): (string | number)[] {
  return [
    l.completedAt, l.vendor, l.worktypeLabel, l.subtypeLabel, l.scope,
    l.community, l.address, l.locality,
    l.vendorCost, l.clientCost, l.reviewDecision || 'approve', l.fromMaster ? 'Yes' : 'No',
  ];
}
