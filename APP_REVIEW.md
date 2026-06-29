# ResiWALK — End-to-End App Review

_Date: 2026-06-28. A full vet of setup/structure/functionality: what's solid,
what's missing, prioritized enhancements, and the results of a bug hunt across
auth/security, offline/sync/photo durability, the data layer, and finalize/PDF._

## How this review was done
Parallel deep-reads of four subsystems (auth/session/security; offline/sync/
photo; HubSpot data layer + finalize/PDF; config/build/structure), then **every**
flagged "bug" was verified against the actual code before any change. The test
suite (99 tests) passes and `tsc`/`next build` are clean.

---

## 1. What's already strong (don't change)
- **Offline durability is genuinely well-built.** Queue-first photo capture
  (never blocks on network/IDB), a durable attach outbox, idempotent server
  attach (dedupe-by-URL), a single global sync driver, and now iOS force-quit
  background upload (Phases 1–2). This is the hardest part of a field app and
  it's in good shape.
- **Write-path authorization** is centralized in `lib/inspectionGuard.ts` +
  `lib/userAccess.ts` and applied consistently across write routes (one gap
  found + fixed — see §3).
- **Security headers** (CSP, HSTS, X-Content-Type-Options) are set globally in
  `next.config.js`; the public photo-proxy is rate-limited.
- **Money math** (`lib/rateCardMath.ts`) guards quantity/percent/custom inputs
  and clamps ranges; covered by unit tests.
- **HubSpot datetime fields** correctly write epoch-ms (a deliberate choice,
  documented inline — not a bug despite looking like one).

---

## 2. Bug hunt — verified results (honest)
Most scary-sounding findings turned out to be **correct-by-design** once checked
against the code. Recording them so they aren't "re-discovered" later:

| Claim | Verdict | Why |
|---|---|---|
| PATCH route missing external write guard | ✅ **REAL — fixed** | `pages/api/inspections/[id]/index.ts` PATCH only checked session; any user could rewrite any inspection's `section_list_json`. Now applies `externalWriteDenial()`. (commit `6d7235b`) |
| `approved_at`/`submitted_at` write epoch-ms instead of ISO | ❌ Not a bug | HubSpot datetime props expect epoch-ms; explicit comment at `submit.ts:198`. Writing ISO would break them. |
| `void recordAuditEvent()` can crash on unhandled rejection | ❌ Not a bug | `auditLog.ts:40` is "best-effort; never throws" and wraps in try/catch. |
| Custom price overrides unvalidated → negative/NaN corrupts totals | ❌ Not a bug | `rateCardMath.ts:238-240` guards `!= null && >= 0`; bad values fall back to computed. JSON can't carry Infinity/NaN. |
| `drainPhotoAttachOutbox` deletes deferred entries | ❌ Not a bug | `.json().catch(()=>({}))` then `if (data.deferred) continue` — only a real non-deferred 200 deletes. |
| `regenerateTypes` `String(null)` → `"null"` selector | ❌ Harmless | `"null"` matches no real PDF type; it's an inert no-op selector. |

**Lower-priority, genuinely worth doing (not yet done — see enhancements):**
the finalize double-submit lock is deliberately fail-open (a HubSpot read hiccup
lets a finalize proceed) — reasonable today, but email/ticket side-effects should
be made idempotent rather than relying on the lock.

---

## 3. What I think is missing (setup / structure / functionality)

### A. Observability (highest-value gap)
- **No server-side error monitoring.** Server exceptions (finalize, PDF render,
  HubSpot calls) are only `console.error`'d → invisible unless someone reads
  Vercel logs. Client errors already POST to `/api/telemetry/error`; the server
  has no equivalent. **Add Sentry (or similar)** for server exceptions, focused
  on the finalize/PDF/HubSpot paths. This is the single highest-leverage add.
- **No uptime/health check** endpoint or synthetic monitor for "can we reach
  HubSpot + render a PDF."

### B. CI / quality gates
- The repo has tests + `typecheck` + `check:native-parity`, but **no CI workflow**
  runs them on push/PR. A tiny GitHub Actions workflow (`typecheck` + `test` +
  `build` + `check:native-parity`) would catch regressions before they hit
  `main` (which auto-deploys to prod). Highly recommended given the "ship
  straight to main" workflow.
- Consider a pre-push hook running `tsc --noEmit` + `vitest run`.

### C. Resilience / abuse limits
- **No rate limiting on authenticated mutation routes.** An authenticated client
  looping saves/cancels could hammer HubSpot into 429s. Add a lightweight
  per-user limiter (Vercel KV/Upstash) on the hot mutation routes.
- **Finalize side-effects (email, maintenance ticket) aren't idempotent across
  concurrent runs** — the durable lock is fail-open. Guard each side-effect by
  its own "already-sent/created" marker so a rare double-run can't double-send.
- **PDF generation has no photo-count/size budget.** A pathological inspection
  (hundreds of photos) could time out or OOM the function. Cap embedded photos +
  fall back to links beyond a budget.

### D. Maintainability
- **HubSpot property names are hardcoded strings** in many places
  (`pdf_master_url`, `total_vendor_cost`, …). A typo silently fails to read/write.
  Centralize them in a `HUBSPOT_PROPS` constants module with a TS type.
- **Service worker cache version** falls back to a hardcoded `'v3'` if the
  registration query string is missing → risk of serving a stale shell after a
  deploy. Verify every SW registration passes the build version (or bake the
  hash into the SW filename).
- Several large components (`RateCardForm.tsx`, `QuestionForm.tsx` are 3–4k
  lines). Not urgent, but extracting the photo-capture + autosave hooks into
  shared modules would reduce drift (the offline path already moved this way).

### E. Functionality / product gaps to consider
- **iOS force-quit upload Phase 3 hardening** (already specced): a
  `background`-configured `URLSession` (file-backed) so a transfer that outlives
  the BGProcessingTask window survives suspension, plus a `dedupeKey` on
  `/api/upload` to make foreground/background overlap produce zero duplicate
  hosted copies.
- **A "sync health" surface for admins** — how many devices have queued items,
  oldest unsynced age — would turn the field-loss class of issues from anecdote
  into a dashboard.
- **Automated stale-session / token-refresh UX**: confirm the re-login prompt
  fully replays the outbox after re-auth (the plumbing exists; worth an explicit
  end-to-end test).

---

## 4. Prioritized action list
1. **(Done)** Fix PATCH authorization gap. ✅
2. **(Done)** Server error monitoring — `lib/serverErrorReporter.ts`, provider-
   agnostic via `ERROR_WEBHOOK_URL`, wired into finalize/upload/attach-photo/
   answers. ✅
3. **(Done)** Idempotent finalize side-effects — tight re-read of `hbmm_ticket_id`
   right before ticket creation (window shrunk from the PDF pipeline to ~ms). ✅
4. **(Done)** Rate limiting — `lib/rateLimit.ts` on upload/answers/attach-photo. ✅
5. **(Done)** iOS background upload **Phase 3** — background `URLSession`
   (file-backed, survives suspension) + `/api/upload` `dedupeKey`. All three
   phases now built (native on `chore/native-oauth-outbound`). ✅
6. **CI workflow** — typecheck + test + build + native-parity on push. _(open —
   was item not selected; recommended next.)_
7. **PDF photo budget** + **HubSpot property-name constants** + **SW version
   robustness**. _(open)_

Remaining open items (6–7) are non-urgent hardening. The big field-loss and
observability gaps are now closed.

### Note on item 2 (monitoring) — how to activate
The reporter is provider-agnostic: set the `ERROR_WEBHOOK_URL` env var to a Slack
incoming webhook, a Sentry tunnel, or any HTTP collector and both client and
server errors flow to it. Without the env it just logs structured `[server-error]`
lines (greppable in Vercel). No new dependency or DSN was added.

### Note on rate limits (item 4)
Per-instance token bucket (no external store / secret). Effective cap ≈ configured
max × instance count — enough to stop a single runaway client; for a hard global
cap, back `lib/rateLimit.ts` with Vercel KV (call sites unchanged).

---

## 5. Offline syncing & low-cell-service — review + the "start fully offline" build

### Already solid (verified)
- **Capture/edit offline**: queue-first photos (never block on network/IDB),
  durable answer outbox, idempotent attach outbox, single global sync driver,
  visible sync badge, iOS force-quit background upload (Phases 1–3).
- **Open an EXISTING inspection offline**: falls back to the cached template +
  questions + answers (`lib/offlineCache`) — works once opened on a connection.
- **Home list offline**: localStorage results+facets cache paints stale-while-
  revalidate, so the list shows when warm.
- **Submit gate**: finalize is blocked while anything is still queued, so a weak
  link can't ship a short report.

### The gap — and what was built: START AN INSPECTION FULLY OFFLINE
Creating an inspection used to be a hard server round-trip (HubSpot mints the
record id) → impossible in a dead zone. Now:
- **`new.tsx`** falls back to a **local create** when offline / the create fetch
  throws: it generates a temp record id (`local_<uuid>`) **and the inspection's
  external id** on-device, seeds the offline cache, and opens the form — the
  inspector fills out the whole inspection offline (answers + photos queue
  exactly as normal).
- **`lib/deferredCreate.ts`** (run first in the global sync tick) replays the
  create the moment signal returns, then **re-keys every queued item** from the
  temp id to the real HubSpot record id. Because the temp id is a globally-unique
  opaque token, each store does a blanket token-replace — covering endpoints,
  `inspectionRecordId`, and even Final-Checklist `FINALCHECKLIST-<id>` keys —
  with no partial-rewrite risk (unit-tested).
- **Idempotent create**: keyed by the client-generated external id; the server
  returns the existing record if it already exists, so a retried create can't
  duplicate.
- The open detail page **auto-swaps** `local_…` → the real id when the create
  lands; the home list **merges in** not-yet-synced inspections with a "Not
  synced" badge so they're never lost; submit is gently gated while still local.
- **Stable keys**: generating the external id on-device means all answer/photo
  idempotency keys are correct from the first offline tap — only the record id
  changes on sync. Native mirroring is skipped for local ids (re-key stays
  web-only).

### Known limitations (by design, documented)
- The template's content must have been **cached once on a connection**
  (questions / rate-card catalog) — a brand-new template can't render offline.
  `new.tsx` shows a clear message in that case instead of a broken form.
- An **offline-started QC** can't copy the source scope's lines until sync (the
  copy is server-side) — it opens with empty rooms (standalone QC, already
  supported) and the lines appear on reload after sync.
- **Region** is unknown offline → scope pricing uses the GA:Atlanta fallback
  until the synced record's `region_snapshot` lands (then the detail reloads).
- Needs **real-device field testing** of the full offline→reconnect→re-key→
  redirect path (the re-key logic itself is unit-tested; the orchestration can't
  be exercised in CI).

---

## 6. Engineering lessons — checklist for offline/field changes
Captured after two avoidable bugs in the offline-start build (an LRU-evicted
render source; a no-timeout create that stalled in low service). Run this list
on every offline/field change so we stop the back-and-forth.

### Root causes (what actually went wrong)
1. **Conflated cache with source-of-truth.** The only copy of a not-yet-synced
   inspection was written to an LRU-capped *cache* that the home page's precache
   evicts. Authoritative, un-derivable state must live in a durable, non-evictable
   store and be RENDERED from there — the cache is only an accelerator.
2. **Tested the happy path, not the lifecycle.** "Start → open" worked; the bug
   was in "start → leave → return." New persistent state must be walked through
   its WHOLE lifecycle.
3. **`navigator.onLine` is not "can I reach the server."** In low service it's
   `true` while requests hang. The first build only branched to offline on
   hard-offline / a thrown fetch, so a weak signal = an open-ended spinner.
4. **Fuzzy heuristic instead of the precise signal.** Offline-vs-error was first
   decided by regex on an error message; the right signal is "did `fetch` throw
   (network) vs return an HTTP status (server decision)."

### The checklist (apply BEFORE shipping)
- [ ] **Durable vs cache:** Is this the ONLY copy of user work until sync? If so
      it goes in a durable store (the pending store / IndexedDB / outbox), and the
      UI renders from that store — never from an LRU/evictable cache as the sole
      source.
- [ ] **Lifecycle walk:** create → reload → navigate away → return → app restart →
      reconnect. Each transition is a test case. Name the one that bites.
- [ ] **Every field network call has a timeout + automatic fallback.** Treat
      "slow" as "offline" for UX. Default ~8s for interactive, ~15s for background.
      `navigator.onLine === false` is a fast-path shortcut, NOT the trigger.
- [ ] **Branch on precise signals:** fetch-threw/aborted = network → fallback;
      HTTP 4xx/5xx = server decision → surface it. No message-regex offline checks.
- [ ] **Cross-subsystem interactions:** if you depend on a shared store (an LRU,
      a queue), list who else writes/evicts/drains it and confirm they can't
      undermine you.
- [ ] **Idempotent + opaque-token keys:** client-generate stable ids so a retry
      can't duplicate and a re-key is a blanket token replace, not field surgery.
- [ ] **Write the round-trip test**, even with a mocked store, for the transition
      you can't exercise on-device in CI.
- [ ] **Say what still needs device testing** — don't imply CI coverage proves the
      field path.

### Seamless low-service UX (the standing bar)
The inspector must NEVER watch an open-ended spinner. Anything that touches the
network on the critical path (start, open, save, pick a property) shows cached/
local content immediately and races the network behind it with a short timeout;
on timeout it has already fallen back. Sync is silent and automatic; the only
visible cue is the "saved offline / syncing / Not synced" status — never a dead
wait or a blocking error for a connectivity problem.
