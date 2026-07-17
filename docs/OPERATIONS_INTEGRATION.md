# ResiWalk (resihome-inspection-app) — Integration Notes for ResiHome-Operations

Reference for services in **ResiHome-Operations** (e.g. the "Homer" agent) that need
data the ResiWalk inspection app already owns. Two things people keep re-deriving
incorrectly: **HoneyBadger photo storage** and the **POD approval-routing config**.
This documents the ground truth from the code so you don't build a duplicate.

> Source of truth for everything below: this repo (`resihome-inspection-app`).
> Nothing here requires new infrastructure on the Operations side.

---

## 1. HoneyBadger maintenance photos / `hb-documents` S3

**`hb-documents` is HoneyBadger's S3 bucket (vendor: `honeybadgermm.com`) — NOT a
ResiHome/ResiCap bucket. The inspection app holds NO AWS credentials and never
calls S3 directly.**

Grepped the entire repo: there is **no `@aws-sdk`, no `AWS_ACCESS_KEY_ID`, no
`AWS_SECRET_ACCESS_KEY`, no `AWS_REGION`.** A SigV4 presigner using ResiHome AWS
keys cannot work — those keys don't exist here, and the bucket isn't ours.

### How photos/PDFs actually get into `hb-documents` (`lib/ticketUpload.ts`)
- The app **drives HoneyBadger's web UI with a headless browser** (puppeteer-core
  + @sparticuz/chromium) because *"the External API has no attachment endpoint."*
- It logs in at `https://honeybadgermm.com/` with **`HBMM_USERNAME` / `HBMM_PASSWORD`**
  (the only "HB" creds that exist — these are **HoneyBadger login creds, not AWS**),
  opens the ticket, and uses HoneyBadger's own "Upload Document" flow.
- HoneyBadger stores the bytes in its own S3 and returns **short-lived presigned
  URLs** — the `DocumentURL` values inside the `TicketDocs` registration response.

### Reading documents
- Reads go through **HoneyBadger-issued presigned URLs**, which **expire**.
- Observed semantics (encoded in the upload verifier):
  - **`403` / expired signature** → the object **exists**; the presigned URL just
    lapsed. The live HoneyBadger UI mints a fresh one.
  - **`NoSuchKey` / `404`** → the object was **never durably saved** (a real loss).

### Implication for Operations / Homer
- The env you're waiting on (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) **does
  not exist in the inspection app** — there's nothing to copy, and it wouldn't
  grant access to a vendor bucket anyway.
- To read a HoneyBadger document programmatically you must either:
  1. **Get a fresh presigned URL from HoneyBadger** (replicate the authenticated
     HBMM session the inspection app uses, read the ticket's current
     `TicketDocs[].DocumentURL`, and fetch within its TTL), **or**
  2. **Ask HoneyBadger (the vendor) for real S3 read access / IAM creds to
     `hb-documents`.** Only HoneyBadger can issue those.

---

## 2. POD Approval Routing — read the app's source of truth (do NOT duplicate)

It is **not** a Vercel Blob. It's a JSON string on a **HubSpot custom-object
property**. Read it; don't stand up a second store (two writers = the conflicts
you've been hitting).

### Location
- **Object:** `Agent` custom object — type id **`2-13064238`** (env override
  `HUBSPOT_AGENT_TYPE_ID`).
- **Record:** the singleton "AI-knowledge" Agent record — resolved by env
  **`AI_KNOWLEDGE_AGENT_RECORD_ID`**, else the Agent record whose
  `hubspot_owner_id` matches the owner for **`AI_KNOWLEDGE_ADMIN_EMAIL`**
  (default `hwoods@resihome.com`).
- **Property:** **`app_approval_routing_json`** (string / textarea, group `ai_knowledge`).

### Read (exactly what `lib/hubspot.ts readApprovalRouting` does)
```
GET /crm/v3/objects/2-13064238/{recordId}?properties=app_approval_routing_json
Authorization: Bearer <HUBSPOT_TOKEN>
→ JSON.parse(properties.app_approval_routing_json)   // then normalizeApprovalRouting()
```
Treat the result as **read-only**. The app's `/admin/flows → Approval Routing`
screen is the **sole writer**; a second writer will clobber it.

### Default POD channels (baked in; editable in-app)
| POD | channel name | channel ID |
|-----|--------------|------------|
| georgia | ga-ratecard-review | `C08NEJYDW65` |
| florida | florida-ratecard-review | `C06ET3QPYRY` |
| scattered | scattered-ratecard-review | `C08LQCBGTD1` |
| west | west-ratecard-review | `C087UENA8RF` |

### Related, same record (bonus)
`app_slack_notifications_json` on the same Agent record holds the Slack
notification on/off + sandbox config, if Operations needs it.

---

## 3. Reusable resolver — copy `lib/approvalRouting.ts` VERBATIM

It's a **pure module with zero imports** (types + logic only), so it drops into
any TypeScript service unchanged. Reading the blob and calling `resolveApprovers`
here guarantees identical routing decisions across both apps.

```ts
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
    { users: rc.srPms, nte: rc.srPmNte, level: 'sr_pm', label: 'SR / AM' },
  ];
  for (const t of lowerTiers) {
    const valid = t.users.filter(isUser);
    if (valid.length > 0 && t.nte != null && amtOk && amt <= t.nte) {
      return {
        level: t.level, users: valid, podId: pod.id, podName: pod.name, channelId, channelName, region: rc.region,
        reason: `${amtStr} is within the ${rc.region} ${t.label} ceiling (${money(t.nte)}) → ${t.label}${valid.length > 1 ? ` (${valid.length})` : ''}.`,
      };
    }
  }

  // RM tier — within the RM ceiling (or RM has no ceiling set).
  if (isUser(pod.rm) && (pod.rmNte == null || (amtOk && amt <= pod.rmNte))) {
    const noLower = !rc.pms.some(isUser) && !rc.srPms.some(isUser);
    return {
      level: 'rm', users: [pod.rm], podId: pod.id, podName: pod.name, channelId, channelName, region: rc.region,
      reason: noLower
        ? `No PM / SR / AM set for ${rc.region} → defaults to the ${pod.name} RM.`
        : `${amtStr} is above the PM / SR / AM ceilings → ${pod.name} RM${pod.rmNte != null ? ` (ceiling ${money(pod.rmNte)})` : ''}.`,
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
```

### Usage (Operations side)
```ts
// 1. read + normalize the blob from HubSpot
const raw = await getAgentProperty('2-13064238', recordId, 'app_approval_routing_json');
const config = normalizeApprovalRouting(JSON.parse(raw || '{}'));
// 2. resolve
const who = resolveApprovers(config, 'GA: Atlanta', 12500);
// who.channelId → post target; who.users[].slackId → @-mentions; who.reason → audit line
```

---

## 4. GitHub access
This repo's canonical path is **`HWoods-Resihome/resihome-inspection-app`**. If an
Operations session can't `add_repo` it, that's a workspace access grant (an admin
enables the repo for the session in Claude's GitHub settings), not a naming issue.
