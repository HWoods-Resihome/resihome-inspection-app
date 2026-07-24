/**
 * One-time (idempotent) backfill of region + portfolio onto community-coverage
 * Service Work Orders, across EVERY status (open and closed). Community services
 * carry no linked Property, so both fields are derived from an associated
 * community home (most-common value) and stamped as region_snapshot /
 * portfolio_snapshot — which is what Insights billing reads for community rows.
 *
 * Only fills BLANK fields (so it never clobbers a value and is safe to re-run).
 * Dry-run reports what would change; apply writes it. Admin-gated by the caller.
 */
import {
  searchServiceWorkOrdersByScope,
  fetchCommunityRegionPortfolio,
  patchServiceWorkOrder,
  listServiceCommunities,
} from '@/lib/hubspot';

export interface CommunityGeoBackfillReport {
  configured: boolean;
  mode: 'dry-run' | 'apply';
  communityServices: number;
  updated: number;
  skippedAlreadySet: number;
  skippedNoCommunity: number;
  skippedNoGeo: number;
  samples: { id: string; community: string; region: string; portfolio: string }[];
}

export async function backfillCommunityGeo(apply: boolean): Promise<CommunityGeoBackfillReport | null> {
  const services = await searchServiceWorkOrdersByScope('community', 5000);
  if (services === null) return null; // object type id not configured

  // Name → id fallback for legacy community services that never stored a
  // community_id_ref (older orders predating the ref).
  const byName = new Map<string, string>();
  const communities = (await listServiceCommunities().catch(() => null)) || [];
  for (const c of communities) if (c.name) byName.set(c.name.trim().toLowerCase(), c.id);

  // Resolve each community's region+portfolio once, keyed by community id.
  const geoCache = new Map<string, { region: string; portfolio: string }>();
  const geoFor = async (commId: string): Promise<{ region: string; portfolio: string }> => {
    if (!geoCache.has(commId)) geoCache.set(commId, await fetchCommunityRegionPortfolio(commId));
    return geoCache.get(commId)!;
  };

  const report: CommunityGeoBackfillReport = {
    configured: true, mode: apply ? 'apply' : 'dry-run',
    communityServices: services.length, updated: 0,
    skippedAlreadySet: 0, skippedNoCommunity: 0, skippedNoGeo: 0, samples: [],
  };

  for (const { id, props: p } of services) {
    const commId = String(p.community_id_ref || '').trim()
      || byName.get(String(p.community_name || '').trim().toLowerCase()) || '';
    if (!commId) { report.skippedNoCommunity++; continue; }

    const geo = await geoFor(commId);
    const patch: Record<string, string> = {};
    if (!String(p.region_snapshot || '').trim() && geo.region) patch.region_snapshot = geo.region;
    if (!String(p.portfolio_snapshot || '').trim() && geo.portfolio) patch.portfolio_snapshot = geo.portfolio;

    if (!Object.keys(patch).length) {
      // Either both already set, or the community yielded no value to fill.
      if (geo.region || geo.portfolio) report.skippedAlreadySet++; else report.skippedNoGeo++;
      continue;
    }

    if (apply) await patchServiceWorkOrder(id, patch);
    report.updated++;
    if (report.samples.length < 25) {
      report.samples.push({
        id, community: String(p.community_name || commId),
        region: patch.region_snapshot ?? String(p.region_snapshot || ''),
        portfolio: patch.portfolio_snapshot ?? String(p.portfolio_snapshot || ''),
      });
    }
  }
  return report;
}
