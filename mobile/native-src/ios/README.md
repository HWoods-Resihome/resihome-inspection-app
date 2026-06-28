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

## Notes / limitations (Phase 1)
- Uploads run with an async `URLSession` inside the granted execution window (a
  BGProcessingTask window, or a `beginBackgroundTask` assertion on
  `didEnterBackground`). This covers the dominant field case. **Hardening (phase
  3):** switch to a `background`-configured `URLSession` with file-backed
  upload/download tasks so a transfer that outlives the window survives full
  suspension. The store + state machine are already shaped for that.
- **Auth:** `BgUploader.refreshCookies(from:)` copies the webview session cookie
  into `HTTPCookieStorage.shared` (spec §6 — the main correctness risk). If the
  session is expired when the task runs, POSTs 401 → the queue is **kept** (never
  dropped) and drains after the next in-app login.
- **No duplicates:** the server attach dedupes by URL, and the web clears its
  native mirror in `finishSynced`; a brief foreground/background overlap could
  attach two hosted copies of one image until phase-3 `dedupeKey` lands (spec §7).
- **Server origin** is read from the live webview URL (so it follows a future
  `resiwalk.com` switch) with a constant fallback matching `capacitor.config.ts`.

## Phase 2 (built)
The **answer/line/section** outbox (`lib/offlineOutbox.ts`) is mirrored the same
way — `mirrorAnswer`/`clearAnswer`/`reconcileAnswers` on the plugin, `.ans` files
in the store, and `drainAnswers()` (run BEFORE photos, since an attach can depend
on the answer record a replay creates) replaying each entry's
`{endpoint, method, body}` against the same idempotent server routes. So text +
selection edits also drain after a force-quit. The web half is shipped to `main`;
the same plugin sources cover both phases, so there's no extra integration step
beyond the ones above.
