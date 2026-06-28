# iOS Background Photo/Answer Upload — Implementation Spec

**Status:** Ready to build · **Branch:** `chore/native-oauth-outbound` ·
**Scope:** native (iOS Capacitor shell) + one small web bridge

## 1. Problem

The web app already syncs reliably while it is **running** (foreground on any
page, via `installGlobalSync()` in `pages/_app.tsx`, and via a Background Sync
service worker on Android/Chromium). Two durable client queues hold field work
until it lands:

- **Photo bytes** — IndexedDB, `lib/offlinePhotoStore.ts` (`QueuedPhoto`
  records: compressed JPEG `bytes: ArrayBuffer`, `filename`, an `attach`
  descriptor, `replacesUrl`).
- **Photo attaches** — localStorage `resiwalk_photo_attach_v1`,
  `lib/photoAttachOutbox.ts` (`{ url, replacesUrl, target }`).
- **Answer/line/section edits** — localStorage `resiwalk_outbox_v1`,
  `lib/offlineOutbox.ts`.

**The gap is iOS force-quit.** iOS WebKit has **no Background Sync API**, so
when the app is swiped away (or the OS reclaims it) no JS runs. Queued photos
and edits then cannot upload until the inspector *manually reopens the app*. On
a long route with spotty signal this is exactly when data sits longest on the
device. (Android is already covered: the SW's `sync`/`periodicsync` events fire
while the tab is closed.)

This spec adds a **native iOS background path** that uploads the same queues
using `BGProcessingTask` + a background `URLSession`, so work drains even after
force-quit — without duplicating business logic or weakening the web flow.

## 2. Approach — "native mirror + native uploader"

The webview's IndexedDB/localStorage are **not** readable from native Swift
while the app is suspended (no webview is alive). So the native task cannot read
the existing queues directly. Two candidate designs:

- **A. Headless-webview wake** — `BGProcessingTask` instantiates a hidden
  `WKWebView`, loads the app, lets the existing JS flush run, then ends the
  task. *Rejected:* iOS heavily throttles background JS/network in a webview;
  loads are unreliable and often killed before the flush completes. It also
  needs a live `server.url` round-trip just to boot the app.

- **B. Native mirror + native `URLSession` uploader** ✅ *chosen.* On every
  enqueue, the web hands the **already-compressed bytes + upload metadata** to
  the native layer through a small Capacitor plugin. Native persists them to the
  app container and registers a `BGProcessingTask`. When the task fires (or the
  app is backgrounded), a **background `URLSession`** uploads to the *same*
  server endpoints the web uses — which keeps running even if the app is
  suspended mid-transfer. On next app open, the web reconciles (idempotent, so
  no double-add).

Design B reuses the server contract verbatim (no second upload pipeline on the
backend) and the only new native logic is "POST these bytes, then POST this
attach JSON," both of which the server already makes idempotent.

## 3. Server contract (unchanged — native replicates the web calls)

Native makes exactly the two calls `lib/photoUpload.ts` + `lib/photoAttachOutbox.ts`
make today. **No backend changes.**

### 3a. Upload bytes → hosted URL
`POST /api/upload`
```jsonc
// request
{ "filename": "abc.jpg", "contentType": "image/jpeg", "base64": "<base64 JPEG>" }
// response
{ "url": "https://<hosted>/..." }
```
- Body limit 48 MB; photos are pre-compressed to ≤2 MB on the web side, so the
  mirrored bytes are already small. Native uploads the bytes **as-is** — it must
  NOT re-compress (the web already did, including the GPS/label stamp burn-in).

### 3b. Attach hosted URL → record (idempotent)
`POST /api/inspections/{inspectionRecordId}/attach-photo`
```jsonc
{ "url": "https://<hosted>/...", "replacesUrl": "<optional>",
  "target": { "kind": "section|line|fc", "externalId": "...",
              "field": "photo_urls|after_photo_urls",
              "section": "...", "location": "...", "summaryLabel": "...",
              "fcSlot": "<qid>:<key>" } }
```
- Idempotent: dedupes by URL; returns `{ deferred: true }` (HTTP 200) when the
  parent answer record doesn't exist yet (answer outbox hasn't synced). Native
  treats `deferred` as "keep, retry" — identical to `drainPhotoAttachOutbox`.

### 3c. Answer/line/section edits (optional, phase 2)
`POST /api/inspections/{id}/answers` — the `OutboxEntry.body` is already a
ready-to-send payload; native replays it verbatim. Idempotent (server upserts by
`answer_id_external`).

### Auth
All three require the logged-in **session cookie**. The background `URLSession`
must use a `WKHTTPCookieStore`-seeded `HTTPCookieStorage` (shared) so the
`resiwalk` session cookie rides along. See §6 (Auth & cookies) — this is the
single biggest correctness risk.

## 4. Web bridge changes (small, additive, web repo on `main`)

A new no-op-on-web Capacitor plugin wrapper, mirrored into the existing native
bridge module (`lib/nativeBridge.ts`). All calls are guarded by
`Capacitor.isNativePlatform()` so **web/PWA/Android behavior is unchanged.**

1. **On photo enqueue** — in `offlinePhotoStore.uploadPhotoOrQueue` `queueDraft()`,
   after `putRecord(rec)`, also call:
   ```ts
   void NativeBgUpload.mirrorPhoto({
     localId, inspectionRecordId,
     base64,            // the SAME compressed JPEG bytes, base64
     filename,
     replacesUrl: opts?.replacesUrl,
     attach: opts?.attach,   // the PhotoAttachTarget-shaped descriptor
   });
   ```
   (iOS only; Android/web: no-op.)
2. **On successful web upload + attach** — in `finishSynced` / the flusher
   `onSynced`, call `NativeBgUpload.clearPhoto(localId)` so the native mirror
   doesn't re-upload something the foreground already handled. (Idempotency makes
   a race harmless, but clearing keeps the native queue small.)
3. **On app open / resume** — `installGlobalSync()` already drives the web
   drain. Add one call to `NativeBgUpload.reconcile()` which asks native for the
   set of URLs it has already uploaded-and-attached in the background, so the web
   can drop matching IndexedDB drafts and swap any blob: previews. (Idempotent
   server means this is an optimization, not a correctness requirement.)
4. **Phase 2 (answers):** mirror `offlineOutbox.enqueue*` entries the same way
   (`NativeBgUpload.mirrorAnswer(entry)` / `clearAnswer(id)`).

Plugin TS interface (`mobile/` plugin or `@capacitor/...` definitions file):
```ts
export interface NativeBgUploadPlugin {
  // Phase 1 (built): photos. `target` is the flattened PhotoAttachTarget.
  mirrorPhoto(o: { localId: string; inspectionRecordId: string; base64: string;
    filename: string; replacesUrl?: string; target: PhotoAttachTarget }): Promise<void>;
  clearPhoto(o: { localId: string }): Promise<void>;
  reconcile(): Promise<{ done: { localId: string; url: string }[] }>;
  scheduleProcessing(): Promise<void>;   // request a BGProcessingTask now
  // Phase 2: answers/edits.
  mirrorAnswer(o: { id: string; inspectionRecordId: string; endpoint: string;
    method: string; body: unknown }): Promise<void>;
  clearAnswer(o: { id: string }): Promise<void>;
}
```

## 5. Native iOS implementation

### 5.1 Capacitor plugin (`NativeBgUpload`)
- New Swift plugin in the iOS project (`mobile/ios/App/App/NativeBgUpload/`):
  `NativeBgUploadPlugin.swift` (CAPPlugin bridge) + `BgUploadStore.swift`
  (persistence) + `BgUploader.swift` (URLSession driver).
- Register the plugin in the app (Capacitor 6 auto-registers via
  `CAPBridgedPlugin`/the generated registry; confirm in `AppDelegate`/
  `capacitor.config`).

### 5.2 Persistence (`BgUploadStore`)
- Store each mirrored photo as a file in
  `FileManager.default.containerURL...`/`Application Support/bgupload/`:
  - `<localId>.jpg` — the raw bytes (decode the base64 once, write binary).
  - `<localId>.json` — `{ inspectionRecordId, filename, replacesUrl, attach,
    state: "pending|uploaded", uploadedUrl? }`.
- A small JSON index file is optional; scanning the dir is fine at field volumes
  (tens, not thousands).
- Mirror answers as `<id>.answer.json`.

### 5.3 Background uploader (`BgUploader`)
- One **background** `URLSession`:
  ```swift
  let cfg = URLSessionConfiguration.background(withIdentifier: "com.resihome.resiwalk.bgupload")
  cfg.isDiscretionary = false          // upload promptly when possible
  cfg.sessionSendsLaunchEvents = true  // relaunch app on completion
  cfg.httpCookieStorage = HTTPCookieStorage.shared   // see §6
  ```
- Implement `handleEventsForBackgroundURLSession` in `AppDelegate` to store the
  completion handler and call it when the session reports
  `urlSessionDidFinishEvents`.
- **Upload step:** `uploadTask` to `POST {server.url}/api/upload` with the JSON
  body (filename/contentType/base64). On success parse `url`, write
  `state:"uploaded", uploadedUrl` to the sidecar.
  - *Optimization:* the bytes are already on disk; still send base64 JSON to
    match the existing endpoint exactly (no multipart endpoint exists). Keep
    payloads ≤ the 48 MB limit (they are, post-compression).
- **Attach step:** once `uploadedUrl` is known, `dataTask`/`uploadTask` to
  `POST {server.url}/api/inspections/{id}/attach-photo` with
  `{ url, replacesUrl, target: attach }`.
  - On `{ deferred: true }` → keep the sidecar (state stays `uploaded`,
    attach pending) and retry on the next task fire. Mirrors
    `drainPhotoAttachOutbox`'s deferral handling exactly.
  - On 2xx non-deferred → delete `<localId>.jpg` + sidecar (done).
  - On 401/403 → stop (re-auth needed); leave everything for foreground.
  - On permanent 4xx (not 429) → drop the entry (logged) so it can't wedge.
  - On 429/5xx/network → keep, retry next fire.
- Order: drain answers first, then photo upload, then attach (an attach may
  depend on an answer record the answer-replay creates) — same ordering rule the
  web uses.

### 5.4 Scheduling (`BGTaskScheduler`)
- Register a processing task identifier `com.resihome.resiwalk.bgupload.process`
  in `Info.plist` under `BGTaskSchedulerPermittedIdentifiers` and
  `UIBackgroundModes` = `processing` + `fetch`.
- On `applicationDidEnterBackground` and after every `mirrorPhoto`, submit a
  `BGProcessingTaskRequest` (`requiresNetworkConnectivity = true`,
  `requiresExternalPower = false`). Re-submit from the task handler so it keeps
  rescheduling while work remains.
- Also kick the uploader immediately on `mirrorPhoto` while still foreground/
  background-grace, so the common case (signal returns seconds later) doesn't
  wait for the OS to grant a processing window.
- **Caveat to document for the owner:** iOS decides *when* `BGProcessingTask`
  runs (typically when charging / on Wi-Fi / overnight, and more often for
  frequently-used apps). It is **not** a guaranteed timer. The background
  `URLSession` started while the app was last alive continues regardless; the
  `BGProcessingTask` is what re-kicks *after a cold force-quit*. So the realistic
  guarantee is: "drains in the background within the OS's next granted window,"
  not "instantly after force-quit."

## 6. Auth & cookies (the main risk)
- The webview holds the `resiwalk` session cookie in `WKHTTPCookieStore`. A
  native `URLSession` uses `HTTPCookieStorage`, a **separate** store.
- On app start/resume, copy cookies for the `server.url` host from
  `WKWebsiteDataStore.default().httpCookieStore` into `HTTPCookieStorage.shared`
  (and refresh on `mirrorPhoto`). Without this the background POSTs get 401 and
  silently stall.
- If the session is expired when the task runs, the uploader gets 401 → it must
  **keep** the queue (never drop) and let the next foreground login + web/native
  drain handle it. Surface nothing to the user from the background.

## 7. Idempotency & dedupe (no double photos)
- Foreground web flush and the native task can both run. Safe because:
  - `/api/upload` returns a fresh hosted URL per call, but the **attach** dedupes
    by URL on the record — and the web's `enqueuePhotoAttach`/native both target
    the same record. The risk is *two hosted copies of the same image* attached.
  - **Mitigation:** native clears its mirror on `clearPhoto(localId)` (step 4.2)
    as soon as the web confirms its own upload+attach; and the web's `reconcile()`
    drops drafts whose `localId` native reports `done`. Whichever finishes first
    wins; the other no-ops. A brief overlap could attach two URLs of the same
    photo — acceptable and rare, and dedupe-by-visual is out of scope. To make it
    airtight, phase 2 can switch `/api/upload` to accept a client-supplied
    `dedupeKey = localId` and return the same hosted URL for repeat keys.

## 8. Files to add / touch
**Native (this branch, `chore/native-oauth-outbound`):**
- `mobile/ios/App/App/NativeBgUpload/NativeBgUploadPlugin.swift` (new)
- `mobile/ios/App/App/NativeBgUpload/BgUploader.swift` (new)
- `mobile/ios/App/App/NativeBgUpload/BgUploadStore.swift` (new)
- `mobile/ios/App/App/AppDelegate.swift` — `handleEventsForBackgroundURLSession`,
  `BGTaskScheduler.register`, schedule on background.
- `mobile/ios/App/App/Info.plist` — `BGTaskSchedulerPermittedIdentifiers`,
  `UIBackgroundModes` (`processing`, `fetch`).
- `mobile/package.json` — if packaged as a local plugin, add it; then
  `npx cap sync ios`.
- *(No iOS project exists yet — `mobile/` currently has only `android`. Add the
  iOS platform first: `cd mobile && npx cap add ios`.)*

**Web (separate, ships to `main` — additive, native-guarded):**
- `lib/nativeBridge.ts` — `NativeBgUpload` wrapper (no-op off-iOS).
- `lib/offlinePhotoStore.ts` — `mirrorPhoto` after enqueue; `clearPhoto` in
  `finishSynced`; `reconcile()` hook.
- `pages/_app.tsx` / `lib/globalSync.ts` — call `reconcile()` on resume.
- Phase 2: `lib/offlineOutbox.ts` — mirror/clear answer entries.

## 9. Android note
Android already drains while closed via the SW Background Sync. No native
Android change is required for parity; this spec is iOS-only. (If we later want
a guaranteed Android path independent of the SW, a `WorkManager` job mirrors this
design — out of scope here.)

## 10. Build / verify
- `cd mobile && npx cap add ios && npx cap sync ios`; open
  `mobile/ios/App/App.xcworkspace` in Xcode.
- **Real-device test (required — the simulator can't exercise BGTasks well):**
  1. Sign in, open an inspection, capture several photos **in Airplane Mode**.
  2. Force-quit the app (swipe up).
  3. Restore signal, leave the phone on charger, screen locked.
  4. In Xcode: `e -l objc -- (void)[[BGTaskScheduler sharedScheduler]
     _simulateLaunchForTaskWithIdentifier:@"com.resihome.resiwalk.bgupload.process"]`
     to force the task (or wait for the OS window).
  5. Verify on the server/HubSpot that photos uploaded + attached **without
     reopening the app**, and that reopening shows no duplicates and no
     "X failed to upload" popup.
- Confirm the OAuth `resiwalk://auth-callback` return still works (don't regress
  `AppDelegate`/`Info.plist` while editing them).

## 11. Phasing
- **Phase 1 (photos):** §4.1–4.3, §5, §6, §7 — the field-critical case.
- **Phase 2 (answers/edits):** mirror the answer outbox (§3c, §4.4). Smaller
  payloads, same plumbing.
- **Phase 3 (hardening):** `dedupeKey` on `/api/upload` (§7) for airtight
  no-duplicate guarantee.

## 12. Honest limitations (tell the owner)
- Not instant after force-quit: drains in iOS's next granted background window.
  The in-flight background `URLSession` from the last live moment continues; the
  cold-start re-kick is OS-scheduled.
- If the session cookie is expired when the task runs, upload waits for the next
  in-app login (by design — never drops data).
- A rare foreground/background overlap could attach two hosted copies of one
  photo until phase 3's `dedupeKey` lands.
