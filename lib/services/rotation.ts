/**
 * Vendor rotation for service generation (RECURRING_SERVICES_PLAN.md §10.18).
 *
 * Two rules, in priority order, per net service order:
 *  1. **Sticky per address** — once a property (enrollment key) has an order with a
 *     vendor, every subsequent order for that enrollment keeps the SAME vendor, so a
 *     recurring cut stays with one crew for the life of the enrollment. Sticky only
 *     holds while that vendor is still on the rule; if they were removed, the address
 *     rejoins the balance below.
 *  2. **Equal-volume balance** — a net-new enrollment goes to the rule vendor with the
 *     lowest current OPEN volume; ties break deterministically by the rule's vendor
 *     order. Assignments made during a run reserve volume immediately so multiple
 *     net-new enrollments in one pass spread out (5/4/2 → next two land on the "2").
 *
 * Pure + deterministic (no clock, no I/O) so it is unit-testable. `pickVendor`
 * mutates the state's projected open-volume map to reserve each assignment.
 *
 * Not modelled here: re-enrollment reset (a property that stops then restarts should
 * rejoin the balance). Detecting a true enrollment gap needs the edge-trigger
 * enrollment state from §10.19, which isn't built yet — until then a returning
 * address stays with its prior vendor. Documented limitation, safe default.
 */

export interface ExistingOrder {
  key: string;      // enrollment_key (gen:<ruleId>:<targetId>)
  status: string;   // work-order status
  vendor: string;   // assigned vendor_name ('' if none)
}

export interface RotationState {
  /** enrollment key → vendor already assigned to a prior order for that key */
  stickyByKey: Map<string, string>;
  /** vendor name → projected open volume (existing open orders + this run's reservations) */
  openVolByVendor: Map<string, number>;
}

/**
 * Build rotation state from every existing order. `isOpen` classifies a status as
 * non-terminal (counts toward a vendor's open volume). First-seen vendor wins per
 * key — sticky keeps a key's vendor uniform, so any order for the key is equivalent.
 */
export function buildRotationState(existing: ExistingOrder[], isOpen: (status: string) => boolean): RotationState {
  const stickyByKey = new Map<string, string>();
  const openVolByVendor = new Map<string, number>();
  for (const e of existing) {
    const vendor = (e.vendor || '').trim();
    if (e.key && vendor && !stickyByKey.has(e.key)) stickyByKey.set(e.key, vendor);
    if (vendor && isOpen(e.status)) openVolByVendor.set(vendor, (openVolByVendor.get(vendor) || 0) + 1);
  }
  return { stickyByKey, openVolByVendor };
}

/**
 * Choose the vendor for one order and RESERVE its open volume in `state`. Returns
 * null when the rule has no vendors. Single-vendor rules always return that vendor.
 */
export function pickVendor(vendors: string[], enrollmentKey: string, state: RotationState): string | null {
  const list = vendors.map((v) => String(v || '').trim()).filter(Boolean);
  if (!list.length) return null;

  let chosen: string;
  const prior = state.stickyByKey.get(enrollmentKey);
  if (prior && list.includes(prior)) {
    chosen = prior;                                   // sticky: keep the address's vendor
  } else if (list.length === 1) {
    chosen = list[0];
  } else {
    // Balance: lowest projected open volume; ties → first in the rule's vendor order.
    chosen = list[0];
    let best = state.openVolByVendor.get(list[0]) || 0;
    for (let i = 1; i < list.length; i++) {
      const vol = state.openVolByVendor.get(list[i]) || 0;
      if (vol < best) { best = vol; chosen = list[i]; }
    }
  }

  // Reserve this assignment so subsequent picks in the same run see the new load,
  // and record stickiness so a later order for the same enrollment reuses it.
  state.openVolByVendor.set(chosen, (state.openVolByVendor.get(chosen) || 0) + 1);
  if (enrollmentKey && !state.stickyByKey.has(enrollmentKey)) state.stickyByKey.set(enrollmentKey, chosen);
  return chosen;
}
