# ResiWALK Native Wrapper — Verification & Deploy-Path Status

**Branch:** `feat/native-oauth-return` (HEAD `ec00477`, on baseline `master` `558a5a5`)
**Date:** 2026-06-01
**Scope:** Verify the Capacitor shell + OAuth-return wiring, prove the deep-link
return in the emulator, and produce a read-only plan to land the gated web
changes on the deployable lineage. **No merge, no prod deploy, no force-push.**

---

## TL;DR verdict

| Phase | Result |
|-------|--------|
| 0 — Sanity (clean tree, Capacitor 6) | ✅ PASS |
| 1 — OAuth bridge wired (incl. invoked at startup) | ✅ PASS (1 cosmetic RISK: splash color) |
| 2 — Build health (web + Android debug APK) | ✅ PASS (2 branch fixes applied) |
| 3 — Emulator deep-link return | ⚠️ **PARTIAL** — native half **proven**; web handler is gated behind deploy |
| 4 — Deploy-path diagnosis (read-only) | ✅ Clear, **low-risk** reconcile path found |

**The single gating fact:** the native shell loads the **production** web app via
`server.url` (`https://resihome-inspection-app.vercel.app`). The OAuth bridge code
exists only on this branch (and parked, inert, on `origin/main`) — it is **not
deployed**. So the deep link is correctly caught by the app, but no JS listener
consumes it yet. **Deploying the gated web changes is the unlock** for both the
full Google→native login round-trip and the Play Store submission.

---

## Phase 0 — Sanity

- ✅ Working tree restored and **clean** on `feat/native-oauth-return`.
- ✅ **Capacitor 6** confirmed across all three layers:

| Location | Versions |
|----------|----------|
| root `package.json` | `@capacitor/core ^6.1.2`, `@capacitor/app ^6.0.1`, `@capacitor/browser ^6.0.3` |
| `mobile/package.json` | core/app/browser as above + `network ^6.0.3`, `splash-screen ^6.0.3`, `status-bar ^6.0.1`; devDeps `cli/ios/android ^6.1.2` |
| `mobile/android/variables.gradle` | `compileSdk 34`, `targetSdk 34`, `minSdk 22`, `cordovaAndroidVersion 10.1.1` |
| resolved at `cap sync` | `app@6.0.3`, `browser@6.0.6`, `network@6.0.4`, `splash-screen@6.0.4`, `status-bar@6.0.3` |

---

## Phase 1 — OAuth bridge actually WIRED

| Item | Verdict | Evidence |
|------|---------|----------|
| `lib/nativeBridge.ts` gated by `Capacitor.isNativePlatform()` | ✅ PASS | Hard gate at line 42; returns no-op before installing anything. |
| Client-only, no SSR/build-time native import | ✅ PASS | `typeof window === 'undefined'` guard (l.30) + **dynamic** `import('@capacitor/core')` in try/catch (l.34-39). Web build confirms no SSR break. |
| **Invoked at startup** (critical) | ✅ PASS | `pages/_app.tsx` calls `installOAuthBridge()` inside a client `useEffect([])` (l.13-15). **Not** a dead file. |
| `google-login.ts` writes `client=native` state marker | ✅ PASS | `req.query.client === 'native'` → appends `.native` to `state` (l.54-58); marker rides in `state` to survive the Google round-trip. |
| `gmail/callback.ts` native → `resiwalk://…` with short-TTL token | ✅ PASS | Strips `.native` marker (l.64-67), and on native mints an exchange token and `302 resiwalk://auth-callback?t=<token>` (l.124-132). |
| `lib/auth.ts` create/verify exchange token, jose HS256, reuses `SESSION_SECRET` | ✅ PASS | `createOAuthExchangeToken`/`verifyOAuthExchangeToken`, `alg HS256`, **same** `sessionSecret()`, `typ:'oauth_exchange'`, **≤60s** TTL (l.119-151). |
| `pages/api/auth/exchange.ts` validates token → sets session → `/` | ✅ PASS | Bad/expired/missing → `302 /login?error=…` with **no** session; valid → `createSessionCookie` then `302 /` (whole file). |
| `middleware.ts` makes `/api/auth/exchange` public | ✅ PASS | Present in `PUBLIC_PATHS` (l.15). |
| AndroidManifest `resiwalk://auth-callback` intent-filter on MainActivity | ✅ PASS | `scheme="resiwalk" host="auth-callback"`, `VIEW`+`DEFAULT`+`BROWSABLE` (l.30-35). |
| MainActivity `launchMode="singleTask"` | ✅ PASS | l.17. |
| `CAMERA` + `INTERNET` permissions | ✅ PASS | l.52-53. |
| Camera `uses-feature` (`required="false"`) | ✅ PASS | l.54. |
| Designed launcher icons (default Capacitor icon replaced) | ✅ PASS | `mipmap-*` hold the ResiWALK blue chevron-X foreground (verified visually); adaptive icon uses `@mipmap/ic_launcher_foreground`. |
| Splash `backgroundColor #ff0060` | ⚠️ **RISK / discrepancy** | Splash background is **white `#ffffff`**, not the brand pink `#ff0060`. Set white in `capacitor.config.ts` (`SplashScreen.backgroundColor: '#ffffff'`), `ic_launcher_background.xml` (`#FFFFFF`), and the rendered `splash.png`. The **web** app uses `#ff0060` (logo + input focus). Cosmetic only — **not** a build/functional blocker. Recommend either set the splash to `#ff0060` for brand consistency or accept white intentionally. |

---

## Phase 2 — Build health (the gate)

### Web — ✅ PASS
- `npm install` (root) then `npm run build` → **compiled successfully**. All routes
  built, incl. `/api/auth/exchange`, `/api/auth/gmail/callback`, `/api/auth/google-login`.
- The dynamic `@capacitor/*` import in `nativeBridge.ts` did **not** break SSR/build
  (client-guarded + dynamic import working as designed). No client-guard fix needed.

### Android — ✅ PASS (debug APK produced)
- `cd mobile && npm install` → `npx cap sync android` (found all 5 plugins) →
  `./gradlew :app:assembleDebug` → **BUILD SUCCESSFUL**.
- **Output:** `mobile/android/app/build/outputs/apk/debug/app-debug.apk` (~3.85 MB).
- **JDK used:** Android Studio JBR **21.0.10** (`C:\Program Files\Android\Android Studio\jbr`).
  System default is JDK 25 (unsupported by AGP/Gradle here); no JDK 17 is installed.

**Two branch fixes were required** (both committed to the branch, see end):

1. **`mobile/android/gradle/wrapper/gradle-wrapper.properties`: Gradle `8.2.1 → 8.9.`**
   AGP 8.2.1 + the bundled wrapper (8.2.1) officially supports running only up to
   **JDK 20**; JDK 21 runtime support landed in Gradle 8.5. Since the only acceptable
   JDKs available are 21 and 25 (no 17), bumping the wrapper to 8.9 (which supports
   JDK 21 and is compatible with AGP 8.2.1) is the version-correct fix that keeps the
   build green on JDK 21. *Alternative for a smaller diff: revert to 8.2.1 and install
   a JDK 17 — not done here because JDK 17 isn't present on this machine.*

2. **`mobile/android/local.properties`** had `sdk.dir=C:\Users\…` with **single**
   backslashes. In a Java `.properties` file the backslash is an escape char, so the
   path parsed to garbage → `java.io.IOException: Invalid file path` during
   `:app:compileDebugJavaWithJavac` dependency resolution. Rewrote with forward
   slashes (`sdk.dir=C:/Users/…`). **This file is `.gitignore`d (environment-local) and
   is NOT committed** — each machine generates its own.

**Non-issue ruled out:** `app/src/main/res/values/styles.xml` references
`@color/colorPrimary` / `colorPrimaryDark` / `colorAccent` with no local `colors.xml`.
These are **provided by the `@capacitor/android` library module** (`#3F51B5 / #303F9F /
#FF4081`) via resource merging — confirmed in the merged resources. **Not a blocker.**

---

## Phase 3 — Emulator: deep-link return

**Setup:** Pixel_9_Pro AVD (`emulator-5554`), `adb install -r app-debug.apk`, launched.

1. ✅ App launches; webview loads the **live** web app from `server.url` and renders
   the ResiWALK login page (build `vb6a49a0`). This proves internet works and
   `_app.tsx` ran → `installOAuthBridge()` executed on the native platform.
2. ✅ Fired: `adb shell am start -a android.intent.action.VIEW -d "resiwalk://auth-callback?t=SMOKETEST"`.
   The OS response: **"intent has been delivered to currently running top-most
   instance"** — the deep link was routed **into the app** via `singleTask`, **not**
   to Chrome.
3. ✅ logcat shows Capacitor's native plugin firing the event:
   ```
   Capacitor/AppPlugin: Notifying listeners for event appUrlOpen
   ```
4. ⚠️ **…but immediately:**
   ```
   Capacitor/AppPlugin: No listeners found for event appUrlOpen
   ```
   No JS `appUrlOpen` listener was registered, so the webview did **not** navigate to
   `/api/auth/exchange`. Post-fire screenshot: still on the app's own `/login` page
   (it did **not** escape to Chrome).

**Why:** the running webview loads the **deployed production bundle** (`vb6a49a0`),
which **predates** the OAuth bridge. The `installOAuthBridge()` / `App.addListener('appUrlOpen', …)`
code is only on this local branch (and parked on `origin/main`) — **not deployed** to
`server.url`. Independently corroborated:

| Endpoint on production `server.url` | Result | Meaning |
|-------------------------------------|--------|---------|
| `GET /api/auth/exchange` | **HTTP 401** | Route/public-path **not deployed** (middleware blocks it as protected). If deployed it would `302 /login?error=exchange_missing_token`. |
| `GET /api/auth/google-login` | `302 /login?error=invalid_email` | Existing route works — production is simply the older code. |

**Conclusion (proven vs. blocked):**
- ✅ **Native return path PROVEN:** intent-filter + `singleTask` + Capacitor `App`
  plugin all correctly catch `resiwalk://auth-callback` and surface `appUrlOpen`
  inside the app (no Chrome leak).
- ⛔ **Web-side handler is gated behind deploy:** the navigation
  `appUrlOpen → /api/auth/exchange → (bogus token) → /login` cannot be observed until
  the bridge code is live at `server.url`. This is the deploy dependency, made concrete.

---

## Phase 4 — Deploy-path diagnosis (READ-ONLY — nothing changed)

### Git divergence

| Ref | Commit | `package.json` version | Commits |
|-----|--------|------------------------|---------|
| `master` (local baseline) | `558a5a5` | **0.21.9** | 1 |
| `feat/native-oauth-return` | `ec00477` | 0.22.0 | 2 (baseline + OAuth) |
| `origin/main` (fetched) | **`0b30aa0`** | **0.68.1** | 286 |

- **No common ancestor** between the baseline lineage and `origin/main` — they are
  **disjoint histories** (fresh-init baseline vs. the real main). `git merge-base`
  returns nothing; `master` has 1 commit, `origin/main` has 286 not in `master`.
- ⚠️ **Premise correction:** the task expected `origin/main` ≈ `0c537b8` / "v0.21.0-ish"
  and the baseline to be "the latest app (v0.21.9)." In fact **`origin/main` is far
  AHEAD at v0.68.1** (it has advanced past `0c537b8` to `0b30aa0`), and the **baseline
  is well BEHIND**. The baseline is *not* the latest app.
- **Production deploys from the `origin/main` lineage:** the emulator-loaded build
  `vb6a49a0` corresponds to `origin/main` commit `b6a49a0`. `origin/main` HEAD
  (`0b30aa0`, a voice tweak) is **1 commit ahead** of what's live.

### Will the OAuth changes land cleanly on `origin/main`?

The OAuth commit `ec00477` touches 11 files. Against `origin/main`:

| File | On `origin/main`? | Conflict on replay? |
|------|-------------------|---------------------|
| `lib/nativeBridge.ts` | new | ✅ clean add |
| `pages/api/auth/exchange.ts` | new | ✅ clean add |
| `lib/auth.ts` | yes — **identical** to baseline | ✅ clean (merge base matches) |
| `pages/api/auth/gmail/callback.ts` | yes — **identical** to baseline | ✅ clean (merge base matches) |
| `mobile/.../AndroidManifest.xml`, `mobile/NATIVE_OAUTH_RETURN.md` | new under `mobile/` | ✅ clean |
| `middleware.ts` | yes — differs ~6 lines | ⚠️ small conflict |
| `pages/_app.tsx` | yes — differs ~14 lines | ⚠️ small conflict |
| `pages/api/auth/google-login.ts` | yes — differs ~8 lines | ⚠️ small conflict |
| `package.json` | yes — version + deps | ⚠️ trivial conflict |
| `.gitignore` | yes | ⚠️ trivial conflict |

**Read-only `git merge-tree` cherry-pick simulation** (replay `ec00477` onto
`origin/main`, base = `558a5a5`) → conflicts in exactly: **`.gitignore`,
`middleware.ts`, `package.json`, `pages/_app.tsx`, `pages/api/auth/google-login.ts`**.
The two **largest/most critical** auth files (`gmail/callback.ts` = +native branch,
`auth.ts` = +exchange-token helpers) merge **clean**, plus both new files. **Overall
conflict risk: LOW** — 5 small, mechanical files.

### 🔑 Key discovery: the work is already parked on `origin/main`

`origin/main` contains `mobile/oauth-pending/` — a staging folder holding the **entire**
OAuth change set plus a README with apply instructions:

```
mobile/oauth-pending/
  README.md                         (DO-NOT-DEPLOY notes + apply steps)
  NATIVE_OAUTH_RETURN.md            (design, security, test plan, human-only steps)
  AndroidManifest.xml               (intent-filter + CAMERA)
  web-changes/
    lib/auth.ts, lib/nativeBridge.ts
    middleware.ts, pages/_app.tsx
    pages/api/auth/exchange.ts
    pages/api/auth/gmail-callback.ts   (→ goes to gmail/callback.ts)
    pages/api/auth/google-login.ts
```

**All 7 `web-changes/` files are byte-identical to this branch's files.** The feat
branch is effectively the "applied" form of what `origin/main` parked. The README
confirms the parked code is inert because it lives under `mobile/`.
(Note: the README cites `.vercelignore`, but `origin/main` has **no `.vercelignore`**;
the files are inert anyway because they sit under `mobile/`, outside Next's
`pages/`/`lib/` roots, so the production build never compiles them.)

### Recommended reconcile + deploy strategy

Do **not** try to reconcile the whole baseline tree onto main (it's v0.21.9 and would
clobber 286 commits = data loss). Land **only** the OAuth delta:

1. Cut a branch from the deployable lineage:
   `git switch -c chore/enable-native-oauth origin/main`
2. Apply the OAuth web changes (the parked `mobile/oauth-pending/web-changes/` files
   are the canonical source; `git cherry-pick ec00477` is equivalent):
   - **Clean:** add `lib/nativeBridge.ts`, `pages/api/auth/exchange.ts`; replace
     `lib/auth.ts` and `pages/api/auth/gmail/callback.ts` (bases identical).
   - **Small 3-way merge** (apply the OAuth delta onto `origin/main`'s current
     version — do **not** blindly overwrite): `middleware.ts` (+`/api/auth/exchange`
     in `PUBLIC_PATHS`), `pages/_app.tsx` (+the `installOAuthBridge()` `useEffect`),
     `pages/api/auth/google-login.ts` (+the `client=native` state marker),
     `package.json` (+3 `@capacitor` deps; **keep** the `origin/main` version `0.68.x`),
     `.gitignore`.
3. Native project: ensure `mobile/android` exists on the branch (generate with
   `npx cap add android` if `origin/main` only carries the parked manifest), then
   apply the `resiwalk://auth-callback` intent-filter + permissions from
   `mobile/oauth-pending/AndroidManifest.xml`. **Carry over the two build fixes from
   this branch:** Gradle wrapper `8.9` and the forward-slash `local.properties`
   (gitignored, per-machine).
4. Verify `npm run build`, then deploy a **PREVIEW** (not prod) to obtain a temporary
   `server.url`, point `capacitor.config.ts` `server.url` at it, `npx cap sync`, and
   re-run the emulator deep-link test — **now the JS listener exists**, so the full
   `appUrlOpen → /api/auth/exchange → /login` bounce becomes observable.
5. Promote to production once verified.

### Human-only blockers (cannot be done by the agent)
- **Push access** for `eric.williams` to `origin` (this branch / the new
  `chore/enable-native-oauth` branch are local only — **not pushed**).
- The actual **Vercel production deploy** / promotion.
- The **Google redirect URI** for the production callback is already a registered URI
  (per `NATIVE_OAUTH_RETURN.md`), so production deploy unlocks the live flow directly.

---

## Android deployment runbook (after the backend is deployed)

The debug APK proves the build; the Play Store requires a **signed AAB** from a
**human-owned upload keystore**. **Do NOT create or commit the key** — these are the
steps for a human.

### 1. Generate the upload keystore (HUMAN runs once; store securely, never commit)
```bash
keytool -genkeypair -v \
  -keystore resiwalk-upload.keystore \
  -alias resiwalk-upload \
  -keyalg RSA -keysize 2048 -validity 10000
```
Keep `resiwalk-upload.keystore` out of the repo (e.g. a password manager / secure vault).

### 2. `mobile/android/keystore.properties` (gitignored — never commit)
```properties
storeFile=/absolute/path/to/resiwalk-upload.keystore
storePassword=********
keyAlias=resiwalk-upload
keyPassword=********
```
Add to `mobile/android/.gitignore`: `keystore.properties` and `*.keystore`.

### 3. Gradle `signingConfigs` reading the gitignored file (`mobile/android/app/build.gradle`)
```gradle
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
```

### 4. Build the signed AAB
```bash
cd mobile && npx cap sync android
cd android && ./gradlew bundleRelease
# → app/build/outputs/bundle/release/app-release.aab
```

### 5. Play Console submission checklist
- **Internal testing** track: create the app, upload `app-release.aab`, add testers.
- **Data safety** form: declare **Camera/Photos** (the app uses the device camera and
  file inputs for inspection photos); declare any account/auth data collected.
- **Content rating** questionnaire: complete it (business/utility app).
- **Privacy policy URL**: required — host a privacy policy and supply the URL.
- App access: provide test credentials (an active HubSpot-recognized email) since the
  app is login-gated, so Google review can sign in.
- Target API level: `targetSdk 34` meets current Play requirements.

---

## Plain statement of the unlock

> **The full Google → native login round-trip cannot be tested until the gated web
> changes are live at `server.url` (production).** The native shell loads the deployed
> web app, the production callback is already a registered Google redirect URI, and
> the emulator has proven the native deep-link return works. **Deploying the web
> changes (Phase 4 plan) is the prerequisite** for both the end-to-end login test and
> the Play Store submission.

---

## Branch changes made by this pass (on `feat/native-oauth-return` — not pushed)
- `mobile/android/gradle/wrapper/gradle-wrapper.properties`: Gradle `8.2.1 → 8.9` (JDK 21 support).
- `mobile/WRAPPER_STATUS.md`: this report.
- *(uncommitted, gitignored)* `mobile/android/local.properties`: SDK path fixed to forward slashes (per-machine; not for commit).
