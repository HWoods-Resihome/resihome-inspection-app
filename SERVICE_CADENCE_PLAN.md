# Service Cadence Redesign — Recurring Generation Plan

Planning doc for reworking how recurring Service Rules generate work orders.
No code yet. Owner-approved decisions are captured inline. Companion to
`RECURRING_SERVICES_PLAN.md`; touches `lib/services/generate.ts` and
`pages/services/rules.tsx`.

## 1. The problem we're fixing

Today one "cadence" field tries to be three things at once:

1. an interval (`every X days/weeks`),
2. a **separate** "due within N days of creation" window, and
3. an implicit "regenerate the next one whenever the last one closes."

The generation engine then **ignores the interval and weekday entirely** and
only uses the due-window + the one-open-order check. The result is "one order
at a time, regenerated whenever the previous closes, due = created + N" — with
no real anchor to a calendar day. That's the confusing behavior.

The fix: **stop treating property and community rules the same.** They need
opposite behaviors.

| | Property | Community (contract) |
|---|---|---|
| Driver | Completion-anchored (self-healing) | Calendar-anchored (contract) |
| Open orders at once | Exactly one per property | May overlap when behind |
| Next order created | Immediately after prior **closes** | The day after prior order's **due date** |
| Ignores completion? | No — anchors to it | Yes — marches on the calendar |

Common simplification for both: **the due date IS the scheduled service date.**
The old "due within N days of creation" window is retired for recurring rules
(kept only as the optional "first order due earlier" seed).

---

## 2. Property model — "anchored, self-healing cadence"

### Core rule (one formula)

> **next_due = max(scheduled_due, submitted_at) + interval_days**

- `scheduled_due` = the closing order's own due date.
- `submitted_at` = when the **vendor reported the service done** (the actual
  service date). **[DECISION: anchor on `submitted_at`, fallback `completed_at`
  if a manual close skipped submit.]**
- `interval_days` = the cadence interval (7, 14, …) in days.

The next order is **created immediately** on the first daily generation run
after the current one closes. The one-open-order-per-property invariant stays
exactly as today.

### Why `max(...)` is the whole trick

- Finish **early or on time** → `scheduled_due` wins → you stay locked to the
  fixed rhythm (next Friday).
- Finish **late** → `submitted_at` wins → the schedule honestly re-anchors to
  when the work actually happened, so you always get a true `interval_days` gap.
  **[DECISION: late completion drifts the anchor to the new day and stays there
  — confirmed.]**

### Worked examples (7-day, anchored to Friday)

| Scenario | scheduled_due | submitted_at | next_due = max(...)+7 | Next order created |
|---|---|---|---|---|
| Cut early | Fri 4/10 | Wed 4/8 | **Fri 4/17** | ~Thu 4/9 (day after close) |
| Cut late | Fri 4/10 | Sat 4/11 | **Sat 4/18** | Sun 4/12 (day after close) |

14-day is identical with `+14`.

### First order

Seeded by the existing "initial due" setting (an earlier first due is allowed),
which sets the starting anchor; the formula takes over from occurrence #2.
The anchor weekday comes from the cadence's `dow` (e.g. next Friday).

---

## 3. Community model — "contract calendar"

Contracts bill on a schedule regardless of field reality, so community
generation is **completion-independent** and driven purely by dates.

### Timing rule **[DECISION]**

The new order must **not** create and be due on the same day. So:

> **creation_date(n+1) = due_date(n) + 1 day**
> **due_date(n+1)      = due_date(n) + interval_days**

### Worked example (1/week, Fridays)

| Order | Created | Due |
|---|---|---|
| #1 | (seed) | Fri 4/10 |
| #2 | Sat 4/11 | Fri 4/17 |
| #3 | Sat 4/18 | Fri 4/24 |

Creation marches on the calendar the day after each due date, **whether or not
the previous order is closed.** If the vendor is behind, orders legitimately
overlap (open #1 + open #2) — that's the contract intent.

### Idempotency — date-stamped enrollment key

> `gen:<ruleId>:<communityId>:<due-date-YYYY-MM-DD>`

Because the key includes the occurrence's due date, the same scheduled date
never double-creates, yet last week's still-open order doesn't block this
week's. No open-status gating at all.

### Backlog alert (not a cap) **[DECISION]**

The contract keeps generating no matter what — we never stop it. But when
**≥ 3 open orders of the same type** (same worktype + subtype) pile up for a
single community, raise an alert in **Admin ▸ Error Log** so the backlog is
visible. Alert-only: generation continues; the count is per
`(communityId, worktype, subtype)` measured against open (non-terminal) orders.

---

## 4. Skip months **[DECISION]**

Skip months are evaluated **by the candidate due date's month** (not creation
month). When the next occurrence's `due_date` falls in a skip month, that
occurrence is **not generated**; the schedule advances by whole intervals until
`due_date` lands in an active month, then resumes.

- **Property:** compute `next_due`; while `month(next_due)` is a skip month,
  `next_due += interval_days`. Seasonal resume in spring.
- **Community:** advance `due_date(n+1)` the same way before minting the
  date-keyed order.

**Seasonal-resume timing [DECISION — confirmed]:** to avoid an order sitting
open all winter, defer *creation* of the post-gap order until the daily run that
is within one `interval_days` of the resumed due date (rather than creating it
in October dated to March). Property still respects "one open at a time"; this
just delays the dormant-season create.

---

## 5. Data dependencies (all already exist)

- `submitted_at` (DTIME) — the service-completion anchor. ✅ present, stamped on
  vendor submit (`pages/api/services/[id]/submit.ts`).
- `completed_at` (DTIME) — approval/close time; fallback anchor. ✅
- `due_date` (DATE) — the closing order's scheduled due. ✅
- `enrollment_key` — extended for community to carry the due date. ✅ (string)

The engine already reads existing orders' keys/status. It will additionally need
each closing order's `submitted_at` + `due_date` per key — a projection add to
`readServiceWorkOrderKeys` (or a sibling read), not new HubSpot props.

---

## 6. Engine changes — `lib/services/generate.ts`

1. Branch generation by `scope`:
   - **property** → completion-anchored path (§2),
   - **community** → contract-calendar path (§3).
2. Replace the "due = today + dueWindow" computation with the per-model
   next_due math.
3. Read the most recent closed order per enrollment key (its `submitted_at` +
   `due_date`) to seed the property formula.
4. Community: iterate scheduled due dates from the anchor, mint one date-keyed
   order per occurrence whose `creation_date` ≤ today and due month is active.
5. Skip-month roll-forward (§4).
6. Keep dry-run/apply parity and the vendor-rotation reservation logic intact.

## 7. UI changes — `pages/services/rules.tsx`

- Cadence editor becomes: **"every N days"** (the default and only interval unit
  — days/weeks/months selector is removed) **+ anchor weekday seed + active
  months.** Remove the per-cadence "due within N days" field for recurring
  rules.
- **Monthly-on-day-X mode [DECISION]:** a separate, explicit option for
  date-locked contracts (e.g. "the 1st of every month," "first Friday") — a true
  calendar-month cadence, **not** a 30-day approximation. Reserved mainly for
  community contracts that bill on a fixed monthly date; the default everywhere
  else stays "every N days."
- Keep the rule-level "first order due" (initial-due) as the anchor seed.
- Copy/help text: property = "regenerates after each is completed, self-healing
  from the service date"; community = "generates on a fixed contract schedule,
  the day after each due date."

## 8. Migration / backward compatibility

- **Existing rules:** map old cadence `{unit, interval, dow, dom, months,
  dueDays}` → new `{interval_days, dow, months}`; drop `dueDays` for recurring
  (or migrate it into initial-due once). Existing `initial_due_days` stays.
- **Existing open orders:**
  - Property keys `gen:rule:prop` are unchanged — no data migration.
  - Community switches to date-keyed. First run after deploy: seed the anchor
    from the newest existing community order's due date so we don't double-fire.
- Roll out behind the same manual dry-run first (verify the preview matches
  expectations before the nightly cron applies).

## 9. Decisions log

| # | Topic | Decision |
|---|---|---|
| 1 | Late completion | Drift anchor to the new day, and stay there. ✅ |
| 2 | Anchor timestamp | Vendor-entered **Service Completed Date** (`service_completed_date`, from the completion form) — falls back to `submitted_at` → `completed_at` → `due_date`. So a Friday cut submitted Monday re-anchors from Friday. ✅ |
| 3 | Community timing | Create day after prior **due**; due = prior due + interval. ✅ |
| 3b | Community backlog | Never cap; **alert when ≥ 3 open orders of same type** per community (Admin ▸ Error Log). ✅ |
| 4 | Skip months | Respect by **due-date month**; roll forward to next active month. ✅ |
| 4b | Seasonal resume timing | Defer create to within one interval of resumed due. ✅ |
| 5 | Cadence unit | **"Every N days"** default (drop weeks/months) + explicit **monthly-on-day-X** mode for date-locked contracts. ✅ |

## 10. Suggested phasing

1. **Engine — property model** (§2) behind dry-run; validate examples.
2. **Engine — community model** (§3) + date-keyed keys; validate stacking.
3. **Skip-month roll-forward** (§4) for both.
4. **Rules UI** simplification (§7) + migration (§8).
5. Enable nightly apply; watch Admin ▸ Error Log.
