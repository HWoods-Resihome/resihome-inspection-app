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
  /** PMs for this region — ALL are tagged when an approval is within the PM tier ceiling. */
  pms: ApprovalUser[];
  /** PM tier not-to-exceed ceiling ($). null = not set (PM tier skipped). */
  pmNte: number | null;
  /** Sr. PMs for this region — ALL are tagged when within the Sr. PM tier ceiling. */
  srPms: ApprovalUser[];
  /** Sr. PM tier not-to-exceed ceiling ($). null = not set (Sr. PM tier skipped). */
  srPmNte: number | null;
}

export type PodId = 'georgia' | 'florida' | 'scattered' | 'west';

export interface PodRouting {
  id: PodId;
  name: string;
  /** Slack channel ID the POD's pending-approval notifications post to. */
  channelId: string;
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

/** Default Slack rate-card-review channel per POD (editable in the admin UI). */
export const DEFAULT_POD_CHANNELS: Record<PodId, { channelName: string; channelId: string }> = {
  georgia: { channelName: 'ga-ratecard-review', channelId: 'C08NEJYDW65' },
  florida: { channelName: 'florida-ratecard-review', channelId: 'C06ET3QPYRY' },
  scattered: { channelName: 'scattered-ratecard-review', channelId: 'C08LQCBGTD1' },
  west: { channelName: 'west-ratecard-review', channelId: 'C087UENA8RF' },
};

export type ApprovalLevel = 'pm' | 'sr_pm' | 'rm' | 'director';

export interface ApprovalRecipients {
  level: ApprovalLevel;
  /** Users to @-mention (those with a Slack ID are mentionable; others are name-only). */
  users: ApprovalUser[];
  podId: PodId | null;
  podName: string | null;
  /** Slack channel to post to (the matched POD's channel); null when unmapped. */
  channelId: string | null;
  channelName: string | null;
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
    pods: POD_DEFS.map((p) => ({ id: p.id, name: p.name, channelId: DEFAULT_POD_CHANNELS[p.id].channelId, rm: null, rmNte: null, regions: [] })),
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

/** Sanitize a list of users; accepts an array, falling back to a legacy single user. */
function cleanUserList(arr: any, legacySingle?: any): ApprovalUser[] {
  const src = Array.isArray(arr) ? arr : (legacySingle != null ? [legacySingle] : []);
  const out: ApprovalUser[] = [];
  for (const u of src) { const c = cleanUser(u); if (c) out.push(c); }
  return out;
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
        // Accept arrays; migrate a legacy single `pm`/`srPm` into the list.
        pms: cleanUserList(r?.pms, r?.pm),
        // Migrate the legacy single region `nte` onto the PM tier when present.
        pmNte: cleanNte(r?.pmNte ?? r?.nte),
        srPms: cleanUserList(r?.srPms, r?.srPm),
        srPmNte: cleanNte(r?.srPmNte),
      });
    }
    const channelId = String(src.channelId || '').trim() || DEFAULT_POD_CHANNELS[def.id].channelId;
    return { id: def.id, name: def.name, channelId, rm: cleanUser(src.rm), rmNte: cleanNte(src.rmNte), regions };
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
  const match = findRegion(config, region);
  if (!match) {
    return {
      level: 'director', users: config.directors.slice(), podId: null, podName: null,
      channelId: null, channelName: null, region: region || null,
      reason: `Region "${region || '(none)'}" isn't mapped to a POD — defaulting to the director tier.`,
    };
  }
  const { pod, region: rc } = match;
  const channelId = pod.channelId || DEFAULT_POD_CHANNELS[pod.id].channelId;
  const channelName = DEFAULT_POD_CHANNELS[pod.id].channelName;
  const amt = Number(amount);
  const amtOk = Number.isFinite(amt) && amt >= 0;
  const money = (n: number) => `$${Number(n || 0).toLocaleString()}`;
  const amtStr = amtOk ? money(amt) : 'Amount';

  // Ladder: PM → Sr. PM → RM → Directors. A tier is chosen only if it has at
  // least one user AND its NTE covers the amount; ALL users at the chosen tier
  // are tagged. An empty tier or an unset/too-low NTE falls through to the next
  // (so an empty PM/Sr. PM defaults to the RM).
  const lowerTiers: { users: ApprovalUser[]; nte: number | null; level: ApprovalLevel; label: string }[] = [
    { users: rc.pms, nte: rc.pmNte, level: 'pm', label: 'PM' },
    { users: rc.srPms, nte: rc.srPmNte, level: 'sr_pm', label: 'Sr. PM' },
  ];
  for (const t of lowerTiers) {
    const valid = t.users.filter(isUser);
    if (valid.length > 0 && t.nte != null && amtOk && amt <= t.nte) {
      return {
        level: t.level, users: valid, podId: pod.id, podName: pod.name, channelId, channelName, region: rc.region,
        reason: `${amtStr} is within the ${rc.region} ${t.label} ceiling (${money(t.nte)}) → ${valid.length > 1 ? `${valid.length} ${t.label}s` : t.label}.`,
      };
    }
  }

  // RM tier — within the RM ceiling (or RM has no ceiling set).
  if (isUser(pod.rm) && (pod.rmNte == null || (amtOk && amt <= pod.rmNte))) {
    const noLower = !rc.pms.some(isUser) && !rc.srPms.some(isUser);
    return {
      level: 'rm', users: [pod.rm], podId: pod.id, podName: pod.name, channelId, channelName, region: rc.region,
      reason: noLower
        ? `No PM / Sr. PM set for ${rc.region} → defaults to the ${pod.name} RM.`
        : `${amtStr} is above the PM / Sr. PM ceilings → ${pod.name} RM${pod.rmNte != null ? ` (ceiling ${money(pod.rmNte)})` : ''}.`,
    };
  }

  // Directors — above the RM ceiling, or no RM configured.
  return {
    level: 'director', users: config.directors.slice(), podId: pod.id, podName: pod.name, channelId, channelName, region: rc.region,
    reason: isUser(pod.rm)
      ? `${amtStr} exceeds the ${pod.name} RM ceiling (${money(pod.rmNte ?? 0)}) → director tier.`
      : `No RM configured for ${pod.name} → director tier.`,
  };
}
