/**
 * Community grass-cut MASTER — covered-property list (RECURRING_SERVICES_PLAN.md).
 *
 * GET  → { covered: Prop[], available: Prop[], perRate, count, vendorCost }
 *        `covered` = the properties this master currently bills for; `available` =
 *        every OTHER property in the community (eligible or not) the reviewer may
 *        add. Both carry address/locality for the picker.
 * POST { propertyIds: string[] } → set the covered list, recompute count +
 *        vendor_cost (= count × per-property rate) + client_cost, return the new
 *        snapshot. Internal reviewers only; the master must not already be split.
 *
 * Per the locked decisions: the reviewer can add ANY property associated to the
 * community (regardless of rrqc) that isn't already covered, and dropping recomputes
 * the price down.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { resolveServiceViewerAsync, servicesViewerAllowed } from '@/lib/services/scopeServer';
import { serviceVisibleTo } from '@/lib/services/scope';
import type { SampleService } from '@/lib/services/sampleData';
import { fetchServiceWorkOrder, patchServiceWorkOrder, fetchCommunityProperties } from '@/lib/hubspot';
import { isCommunityCutMaster, parseIds } from '@/lib/services/split';
import { recordServiceAudit } from '@/lib/services/serviceAudit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'POST'].includes(req.method || '')) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const internal = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  // Editing the covered list (POST) is internal-only. A scoped vendor may READ
  // (GET) the covered-home list for a service assigned to them — they need the
  // street addresses to service the route. Ownership is verified below.
  if (req.method === 'POST' && !internal) return res.status(403).json({ error: 'Internal reviewers only' });
  if (!internal && !(await servicesViewerAllowed(email).catch(() => false))) return res.status(403).json({ error: 'Not authorized' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ preview: true, covered: [], available: [] });
    const p = rec.props;
    // Vendor read: only for a service assigned to them.
    if (!internal) {
      const viewer = await resolveServiceViewerAsync(session, req);
      if (!viewer.canSeeAll && !serviceVisibleTo(
        { vendor: p.vendor_name || null, vendorEmail: String(p.vendor_email || '').trim() || null } as SampleService,
        viewer,
      )) {
        return res.status(403).json({ error: 'Not authorized for this service.' });
      }
    }
    if (!isCommunityCutMaster(p)) return res.status(400).json({ error: 'Not a community grass-cut master.' });
    if (p.for_billing === 'false' || String(p.split_at || '').trim()) return res.status(409).json({ error: 'This master has already been split — its covered list is final.' });

    const communityId = String(p.community_id_ref || '').trim();
    const all = communityId ? await fetchCommunityProperties(communityId) : [];
    const perRate = Number(p.per_property_rate) || 0;
    const markup = Number(p.markup_pct);

    if (req.method === 'GET') {
      const coveredSet = new Set(parseIds(p.covered_property_ids));
      const shape = (x: typeof all[number]) => ({ id: x.id, address: x.address, locality: x.locality, rrqc: !!x.rrqcPassDate, status: x.status });
      const covered = all.filter((x) => coveredSet.has(x.id)).map(shape);
      // Keep any covered ids we couldn't resolve (defensive) so the count stays honest.
      for (const cid of coveredSet) if (!all.some((x) => x.id === cid)) covered.push({ id: cid, address: `Property ${cid}`, locality: '', rrqc: false, status: '' });
      const available = all.filter((x) => !coveredSet.has(x.id)).map(shape);
      return res.status(200).json({ covered, available, perRate, count: covered.length, vendorCost: Number(p.vendor_cost) || 0 });
    }

    // POST — set the covered list.
    const body = req.body || {};
    const ids = Array.isArray(body.propertyIds) ? body.propertyIds.map(String).filter(Boolean) : null;
    if (!ids) return res.status(400).json({ error: 'propertyIds (array) required' });
    // Restrict to properties actually in this community (fall back to allowing the
    // set as-is if we couldn't load the community, so a read blip can't wipe it).
    const inCommunity = new Set(all.map((x) => x.id));
    const clean = [...new Set(all.length ? ids.filter((x: string) => inCommunity.has(x)) : ids)];
    if (!clean.length) return res.status(400).json({ error: 'At least one property must remain covered.' });

    const count = clean.length;
    const vendorCost = Math.round(count * perRate * 100) / 100;
    const props: Record<string, any> = {
      covered_property_ids: JSON.stringify(clean),
      covered_property_count: count,
      vendor_cost: vendorCost,
    };
    if (Number.isFinite(markup)) props.client_cost = Math.round(vendorCost * (1 + markup / 100) * 100) / 100;
    await patchServiceWorkOrder(id, props);
    void recordServiceAudit({ serviceId: id, action: 'edit', actorEmail: email, actorName: session?.name, detail: `Covered properties set to ${count} (vendor cost $${vendorCost.toFixed(2)})`.slice(0, 500), meta: { coveredCount: count } });
    return res.status(200).json({ ok: true, count, vendorCost, clientCost: props.client_cost ?? null });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
