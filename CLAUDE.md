# CLAUDE.md — ResiHome / ResiWALK working notes

Read this before making changes. **Every change must consider BOTH the web app
and the native mobile shell.** They ship together; keep them in lockstep.

## What this project is
- **Web app** (this repo root: `pages/`, `lib/`, `components/`, `styles/`,
  `middleware.ts`): the live ResiHome inspection app, deployed to Vercel
  (`resiwalk.com` / `resihome-inspection-app.vercel.app`). Push to `main` →
  auto-deploys. This is where day-to-day feature work happens.
- **Native mobile shell** (`mobile/`, branch `chore/native-oauth-outbound`): a
  **Capacitor 6 thin wrapper** (`com.resihome.resiwalk`) that loads the LIVE web
  app via `server.url` — it does NOT bundle the web build (`webDir: www` is just
  an offline fallback page). Native layer adds: app icon/splash, OS permissions,
  the Google-login `resiwalk://auth-callback` deep-link return, and plugins.
  Android Studio project: `mobile/android` (a subfolder, not the repo root).

### The key consequence
Because the app loads the live site, **pure web changes reach the native app
automatically on deploy — no rebuild.** BUT some web changes need a matching
**native** change or they silently break on a real device.

## ✅ Web ↔ Mobile parity checklist (run on every change)
When a change touches any of these, update the native side too (on
`mobile/`), then note it so the next native build picks it up:

1. **New device capability used by the web** → add the Android permission in
   `mobile/android/app/src/main/AndroidManifest.xml` (and iOS `Info.plist` when
   that exists):
   - camera (`getUserMedia` video) → `CAMERA`
   - microphone (voice / video-with-audio, e.g. the AI camera) → `RECORD_AUDIO`
     (+ `MODIFY_AUDIO_SETTINGS`)
   - GPS / `navigator.geolocation` (evidence stamp, proximity) →
     `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION`
   - notifications, contacts, etc. → the corresponding permission + plugin.
2. **New deep link / custom scheme or OAuth/redirect change** → update the
   `<intent-filter>` in the manifest and the handler in
   `mobile/android/app/src/main/java/com/resihome/resiwalk/MainActivity.java`
   (current scheme: `resiwalk://auth-callback`).
3. **New external host the webview must navigate to in-app** → add it to
   `server.allowNavigation` in `mobile/capacitor.config.ts` (OAuth hosts stay
   OUT — those must open in the system browser).
4. **New Capacitor/native plugin** → add to `mobile/package.json` and run
   `npx cap sync android`.
5. **Branding** (icon/splash/colors) → `res/mipmap-*`, `res/drawable*/splash.png`,
   `res/values/colors.xml` (brand pink `#ff0060`), `SplashScreen.backgroundColor`.
6. **Served origin / domain change** → `server.url` in `mobile/capacitor.config.ts`
   (currently the Vercel URL; switch to `resiwalk.com` after Safe Browsing clears),
   plus `allowNavigation`.

If a web change is purely UI/logic on an existing capability, **no native change
is needed** — it flows through `server.url` on the next deploy.

## Hard rules
- **Never change `server.url` casually** — it controls which site the app loads.
- Brand color is **`#ff0060`** (pink). Status bar / splash / icon background match it.
- Don't bundle secrets into the native project. Don't force-push. Native work
  lands on `chore/native-oauth-outbound` (not `main`) until native+web are merged.

## Working agreement (owner directive)
- **Ship web work straight to `main` for every ask** — commit and `git push origin
  main` once `npx tsc --noEmit` + `npm run build` pass. `main` auto-deploys to
  Vercel and the native shell picks it up via `server.url`, so this is the
  default delivery path (no feature-branch hand-off needed). Native-only changes
  still land on `chore/native-oauth-outbound` per the hard rule above.
- **`main` is ALWAYS the default push target.** Only push to a test/staging
  branch when the owner explicitly asks for it; otherwise everything web goes to
  `main`. (Native-only work is the sole standing exception →
  `chore/native-oauth-outbound`.) Do not resurrect old per-task branches.

## Multi-session git safety (DO THIS EVERY TASK)
Other Claude sessions and people may be pushing to `main` **at the same time**.
Never edit a stale clone or race a push:
- **Pull BEFORE you edit.** At the very start of every task (before the first
  edit), run `git fetch origin main && git rebase origin/main` (or
  `git pull --rebase origin main`) so you're working on the latest code.
- **Rebase BEFORE every push.** `git fetch origin main && git rebase origin/main
  && git push origin main`. If the push is rejected (someone pushed while you
  worked), rebase onto their commits and retry — do NOT `--force`.
- Non-overlapping changes stack automatically and both survive; only edits to the
  *same lines* conflict — resolve keeping BOTH sides, then continue the rebase.
- If the owner says another session is active, prefer working in different files
  to avoid conflicts, and fetch+rebase between each push.

## Build / verify
- Web: `npx tsc --noEmit` + `npm run build` before committing.
- Native: `cd mobile && npm install && npx cap sync android`, open
  `mobile/android` in Android Studio (Gradle JDK = embedded JBR 21), then
  Build → Make Project. Runbooks: `mobile/BUILD_RUNBOOK.md`,
  `mobile/WRAPPER_STATUS.md`, `mobile/OAUTH_WEBVIEW.md`.
- Real-device test for camera/mic/GPS and the Google-login `resiwalk://` return
  (emulator Google sign-in is unreliable).
