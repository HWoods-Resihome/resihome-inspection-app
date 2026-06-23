/**
 * Approval routing config + resolver — who to tag on Slack when a rate-card
 * scope goes to PENDING APPROVAL, based on the dollar amount and the property's
 * region.
 *
 * Structure (managed in /admin/flows → "Approval Routing"):
 *   - 4 fixed PODs: Georgia, Florida, Scattered, West.
 *   - Each POD has an RM (name + Slack ID) and an RM NTE ceiling.
 *   - Each POD holds REGION cards (seeded from the region matrix, add/delete).
 *       Each region has an optional PM and Sr. PM (name + Slack ID) and a region
 *       NTE ceiling that governs the PM/Sr.PM tier.
 *   - A DIRECTOR-and-above tier: a flat list of users that ALL get tagged when an
 *     approval exceeds the RM's ceiling.
 *
 * Routing (resolveApprovers), given a region + amount:
 *   1. region NTE set, amount ≤ region NTE, and a PM/Sr.PM is filled
 *        → tag the filled PM + Sr.PM.
 *   2. otherwise (PM/Sr.PM empty, or amount above the region NTE):
 *        amount ≤ RM NTE (or RM NTE unset) → tag the RM.
 *   3. amount above the RM NTE → tag every director.
 *   PM and Sr. PM are OPTIONAL: when neither is set the notification defaults to
 *   the RM (per the owner spec).
 *
 * Pure module (no I/O) so it's unit-testable and reusable by the future Slack send.
 */

export interface ApprovalUser {
  /** Display name (free text). */
  name: string;
  /** Slack member ID (e.g. "U0123ABCD") used to @-mention. */
  slackId: string;
}

export interface RegionRouting {
  /** The property region value this card maps to (e.g. "GA: Atlanta"). */
  region: string;
  /** Optional PM for this region. */
  pm?: ApprovalUser | null;
  /** PM not-to-exceed ceiling ($). null = not set (PM tier skipped). */
  pmNte: number | null;
  /** Optional Sr. PM for this region. */
  srPm?: ApprovalUser | null;
  /** Sr. PM not-to-exceed ceiling ($). null = not set (Sr. PM tier skipped). */
  srPmNte: number | null;
}

export type PodId = 'georgia' | 'florida' | 'scattered' | 'west';

export interface PodRouting {
  id: PodId;
  name: string;
  /** Regional Manager for the POD. */
  rm?: ApprovalUser | null;
  /** RM not-to-exceed ceiling ($); above it escalates to the directors. null = no ceiling. */
  rmNte: number | null;
  regions: RegionRouting[];
}

export interface ApprovalRoutingConfig {
  pods: PodRouting[];
  /** Director-and-above tier — ALL are tagged when an approval exceeds the RM NTE. */
  directors: ApprovalUser[];
}

/** The four fixed PODs, in display order. */
export const POD_DEFS: { id: PodId; name: string }[] = [
  { id: 'georgia', name: 'Georgia' },
  { id: 'florida', name: 'Florida' },
  { id: 'scattered', name: 'Scattered' },
  { id: 'west', name: 'West' },
];

export type ApprovalLevel = 'pm' | 'sr_pm' | 'rm' | 'director';

export interface ApprovalRecipients {
  level: ApprovalLevel;
  /** Users to @-mention (those with a Slack ID are mentionable; others are name-only). */
  users: ApprovalUser[];
  podId: PodId | null;
  podName: string | null;
  region: string | null;
  /** Human-readable explanation of why this tier was chosen (for the preview + logs). */
  reason: string;
}

function isUser(u: ApprovalUser | null | undefined): u is ApprovalUser {
  return !!u && typeof u.name === 'string' && u.name.trim() !== '';
}

/** Build an empty config with the 4 fixed PODs and no users. */
export function emptyApprovalRouting(): ApprovalRoutingConfig {
  return {
    pods: POD_DEFS.map((p) => ({ id: p.id, name: p.name, rm: null, rmNte: null, regions: [] })),
    directors: [],
  };
}

function cleanUser(u: any): ApprovalUser | null {
  if (!u || typeof u !== 'object') return null;
  const name = String(u.name || '').trim();
  const slackId = String(u.slackId || '').trim();
  if (!name && !slackId) return null;
  return { name, slackId };
}

function cleanNte(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Normalize/validate a parsed config to the canonical shape: always exactly the
 * 4 fixed PODs (in order), regions deduped by name, users/NTEs sanitized. Tolerant
 * of partial/legacy/garbage input so a hand-edited or older blob can't crash.
 */
export function normalizeApprovalRouting(raw: any): ApprovalRoutingConfig {
  const base = emptyApprovalRouting();
  if (!raw || typeof raw !== 'object') return base;

  const rawPods: any[] = Array.isArray(raw.pods) ? raw.pods : [];
  const byId = new Map<string, any>();
  for (const p of rawPods) if (p && p.id) byId.set(String(p.id), p);

  const pods: PodRouting[] = POD_DEFS.map((def) => {
    const src = byId.get(def.id) || {};
    const seen = new Set<string>();
    const regions: RegionRouting[] = [];
    for (const r of (Array.isArray(src.regions) ? src.regions : [])) {
      const region = String(r?.region || '').trim();
      if (!region || seen.has(region)) continue;
      seen.add(region);
      regions.push({
        region,
        pm: cleanUser(r?.pm),
        // Migrate the legacy single region `nte` onto the PM tier when present.
        pmNte: cleanNte(r?.pmNte ?? r?.nte),
        srPm: cleanUser(r?.srPm),
        srPmNte: cleanNte(r?.srPmNte),
      });
    }
    return { id: def.id, name: def.name, rm: cleanUser(src.rm), rmNte: cleanNte(src.rmNte), regions };
  });

  const directors: ApprovalUser[] = [];
  for (const d of (Array.isArray(raw.directors) ? raw.directors : [])) {
    const u = cleanUser(d);
    if (u) directors.push(u);
  }

  return { pods, directors };
}

/** Find the region card (and its POD) for a region value, across all PODs. */
export function findRegion(
  config: ApprovalRoutingConfig,
  region: string,
): { pod: PodRouting; region: RegionRouting } | null {
  const want = (region || '').trim().toLowerCase();
  if (!want) return null;
  for (const pod of config.pods) {
    for (const r of pod.regions) {
      if (r.region.trim().toLowerCase() === want) return { pod, region: r };
    }
  }
  return null;
}

/**
 * Resolve who to tag for an approval of `amount` in `region`.
 * See the module header for the tier rules. Always returns a result (falls back
 * to the directors, then an empty director tier, so the caller never has nothing).
 */
export function resolveApprovers(
  config: ApprovalRoutingConfig,
  region: string,
  amount: number,
): ApprovalRecipients {
  const directorsResult = (reason: string): ApprovalRecipients => ({
    level: 'director', users: config.directors.slice(), podId: null, podName: null, region: region || null, reason,
  });

  const match = findRegion(config, region);
  if (!match) {
    return directorsResult(`Region "${region || '(none)'}" isn't mapped to a POD — defaulting to the director tier.`);
  }
  const { pod, region: rc } = match;
  const amt = Number(amount);
  const amtOk = Number.isFinite(amt) && amt >= 0;
  const money = (n: number) => `$${Number(n || 0).toLocaleString()}`;
  const amtStr = amtOk ? money(amt) : 'Amount';

  // Ladder: PM → Sr. PM → RM → Directors. A tier is chosen only if its user is
  // set AND its NTE covers the amount; an unset user OR an unset/too-low NTE
  // falls through to the next tier (so an empty PM/Sr. PM defaults to the RM).
  const lowerTiers: { user: ApprovalUser | null | undefined; nte: number | null; level: ApprovalLevel; label: string }[] = [
    { user: rc.pm, nte: rc.pmNte, level: 'pm', label: 'PM' },
    { user: rc.srPm, nte: rc.srPmNte, level: 'sr_pm', label: 'Sr. PM' },
  ];
  for (const t of lowerTiers) {
    if (isUser(t.user) && t.nte != null && amtOk && amt <= t.nte) {
      return {
        level: t.level, users: [t.user], podId: pod.id, podName: pod.name, region: rc.region,
        reason: `${amtStr} is within the ${rc.region} ${t.label} ceiling (${money(t.nte)}) → ${t.label}.`,
      };
    }
  }

  // RM tier — within the RM ceiling (or RM has no ceiling set).
  if (isUser(pod.rm) && (pod.rmNte == null || (amtOk && amt <= pod.rmNte))) {
    const noLower = !isUser(rc.pm) && !isUser(rc.srPm);
    return {
      level: 'rm', users: [pod.rm], podId: pod.id, podName: pod.name, region: rc.region,
      reason: noLower
        ? `No PM / Sr. PM set for ${rc.region} → defaults to the ${pod.name} RM.`
        : `${amtStr} is above the PM / Sr. PM ceilings → ${pod.name} RM${pod.rmNte != null ? ` (ceiling ${money(pod.rmNte)})` : ''}.`,
    };
  }

  // Directors — above the RM ceiling, or no RM configured.
  return {
    level: 'director', users: config.directors.slice(), podId: pod.id, podName: pod.name, region: rc.region,
    reason: isUser(pod.rm)
      ? `${amtStr} exceeds the ${pod.name} RM ceiling (${money(pod.rmNte ?? 0)}) → director tier.`
      : `No RM configured for ${pod.name} → director tier.`,
  };
}
