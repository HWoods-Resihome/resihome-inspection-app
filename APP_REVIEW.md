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
2. **Server error monitoring (Sentry)** — finalize/PDF/HubSpot first.
3. **CI workflow** — typecheck + test + build + native-parity on push.
4. **Idempotent finalize side-effects** (email/ticket markers).
5. **Rate limiting** on authenticated mutation routes.
6. **PDF photo budget** + **HubSpot property-name constants** + **SW version
   robustness**.
7. **iOS Phase 3** (background URLSession + upload dedupeKey).

None of items 2–7 are urgent breakage; they're the difference between "works"
and "operationally hardened." Happy to implement any of them on request.
