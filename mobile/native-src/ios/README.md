# NativeBgUpload — iOS background photo upload (Phase 1)

The iOS half of ResiWALK's force-quit background photo upload. The **web side
is already shipped to `main`** (`lib/nativeBridge.ts`, `lib/offlinePhotoStore.ts`,
`lib/globalSync.ts`) and is a complete no-op until this native plugin exists in
the build. Full design: `mobile/IOS_BACKGROUND_UPLOAD_SPEC.md`.

These files live in `native-src/` because the iOS Xcode project doesn't exist in
the repo yet (Stage 0 was Android-only). They are **source to integrate**, not a
compiled target. Do the integration on a Mac with Xcode.

## What's here
| File | Role |
|---|---|
| `NativeBgUpload/NativeBgUploadPlugin.swift` | Capacitor 6 plugin bridge (`mirrorPhoto` / `clearPhoto` / `reconcile` / `scheduleProcessing`). |
| `NativeBgUpload/BgUploadStore.swift` | Durable file storage for mirrored photos + the completed log. |
| `NativeBgUpload/BgUploader.swift` | BGProcessingTask-driven uploader → `/api/upload` then `/api/inspections/{id}/attach-photo`. |
| `AppDelegate.additions.swift` | Copy-paste: task registration + background drain. |
| `Info.plist.additions.xml` | Copy-paste: `UIBackgroundModes` + `BGTaskSchedulerPermittedIdentifiers`. |

## Integration steps (on a Mac)
1. **Create the iOS project** (first time only):
   ```bash
   cd mobile
   npm install
   npx cap add ios
   npx cap sync ios
   ```
2. **Add the plugin sources** to the Xcode project: drag the `NativeBgUpload/`
   folder into the `App` target (Xcode → *Add Files to "App"…*, "Copy items if
   needed", target = App). Capacitor 6 auto-registers `CAPBridgedPlugin`
   classes — no `.m` file or manual registry edit needed.
3. **Merge `AppDelegate.additions.swift`** into `ios/App/App/AppDelegate.swift`
   (add `import BackgroundTasks`, register the task in `didFinishLaunching`, add
   `applicationDidEnterBackground`).
4. **Merge `Info.plist.additions.xml`** keys into `ios/App/App/Info.plist`.
5. `npx cap sync ios`, open `ios/App/App.xcworkspace`, build to a **real device**.

## Verify (real device — the simulator can't exercise BGTasks well)
1. Sign in, open an inspection, capture several photos in **Airplane Mode**.
2. **Force-quit** the app (swipe up).
3. Restore signal; leave the phone on a charger, screen locked.
4. Force the task from the Xcode debugger console (pause execution first):
   ```
   e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.resihome.resiwalk.bgupload.process"]
   ```
   (or just wait for the OS to grant a window).
5. Confirm on the server / HubSpot that the photos uploaded **and attached**
   without reopening the app, and that reopening shows **no duplicates** and no
   "failed to upload" popup.
6. Regression check: Google sign-in `resiwalk://auth-callback` still works (you
   edited `AppDelegate`/`Info.plist`).

## Notes / limitations
- **Transfers survive suspension (Phase 3).** `BgUploader` uses a
  `background`-configured `URLSession` with **file-backed upload tasks** + a
  delegate, so a transfer kicked while the app was alive (or in the background
  grace window) keeps running even if iOS suspends/terminates the app — and iOS
  relaunches the app on completion (`sessionSendsLaunchEvents`) to finish the
  state update. The BGProcessingTask just *enqueues* tasks and completes; it
  doesn't need to stay alive for the transfer.
- **Auth:** `BgUploader.refreshCookies(from:)` copies the webview session cookie
  into `HTTPCookieStorage.shared` (spec §6 — the main correctness risk). If the
  session is expired when a task runs, POSTs 401 → the work is **kept** (never
  dropped) and drains after the next in-app login.
- **No duplicate hosted copies (Phase 3).** Both the foreground flush and this
  uploader send `dedupeKey = localId`; `/api/upload` folds it into the stored
  filename, so HubSpot's `RETURN_EXISTING` returns the SAME URL for the same
  photo. Combined with attach-by-URL dedupe, foreground/background overlap can no
  longer create a second copy.
- **Still OS-paced after force-quit:** iOS decides when to grant the
  BGProcessingTask window that *kicks* a cold-start drain (typically charging /
  Wi-Fi / overnight, more often for frequently-used apps). The in-flight
  background session from the last live moment continues regardless.
- **Server origin** is read from the live webview URL (so it follows a future
  `resiwalk.com` switch) with a constant fallback matching `capacitor.config.ts`.

## Phase 2 (built)
The **answer/line/section** outbox (`lib/offlineOutbox.ts`) is mirrored the same
way — `mirrorAnswer`/`clearAnswer`/`reconcileAnswers` on the plugin, `.ans` files
in the store, and answer tasks replayed BEFORE photos (an attach can depend on the
answer record a replay creates), each replaying its `{endpoint, method, body}`
against the same idempotent server routes. So text + selection edits also drain
after a force-quit. The web half is shipped to `main`; the same plugin sources
cover all phases, so there's no extra integration step beyond the ones above.

## Phase 3 (built) — the final phase
- **Background URLSession.** `BgUploader` is now a `URLSessionDataDelegate` over a
  `background`-configured session. Each step (upload / attach / answer-replay) is
  a **file-backed `uploadTask`** tagged with a `taskDescription`
  (`upload:<id>` / `attach:<id>` / `answer:<id>`); the delegate advances the
  store's `pending → uploaded → done` state machine as tasks finish and chains
  upload → attach automatically. Transfers survive app suspension/termination and
  relaunch the app to finish (`handleEventsForBackgroundURLSession`, see
  AppDelegate additions §1b). `drain()` enqueues only work not already in flight
  (it checks `getAllTasks`).
- **Upload dedupeKey.** Both halves send `dedupeKey = localId`; the server folds
  it into the stored filename so the same photo resolves to the same hosted URL
  (HubSpot `RETURN_EXISTING`) — zero duplicate hosted copies on foreground/
  background overlap. (Web half shipped to `main`.)

This is the last planned phase — Phases 1–3 cover the full force-quit durability
goal for both photos and edits. No further phases are planned.
