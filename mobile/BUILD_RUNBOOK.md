# ResiWALK Stage 0 — Build & Store Submission Runbook

Stage 0 = a native shell (iOS + Android) that loads the live web app in a webview.
**No web-app logic changes.** Goal: get ResiWALK into the App Store and Play Store
and validate native packaging + store review. This runbook is executed on a **Mac**
(iOS requires macOS + Xcode; Android works on any OS but Android Studio is assumed
installed).

---

## 0. Prerequisites (one-time)
- macOS with **Xcode** (latest) + command-line tools.
- **Android Studio** (latest) + an Android SDK.
- **Node 18+** and npm.
- **Apple Developer Program** membership ($99/yr) — for App Store.
- **Google Play Developer** account ($25 one-time) — for Play Store.
- CocoaPods: `sudo gem install cocoapods` (iOS native deps).

---

## 1. Initialize the shell project
From the `mobile/` folder (inside the web repo — NOT the repo root):
```bash
cd mobile
npm install
# Initialize Capacitor metadata (appId/appName already set in capacitor.config.ts):
npx cap init "ResiWALK" "com.resihome.resiwalk" --web-dir=www
# Add the native platforms (generates ios/ and android/ projects):
npx cap add ios
npx cap add android
# Sync config + plugins into the native projects:
npx cap sync
```
> `npx cap add ios/android` must run on your machine — they generate the native
> Xcode/Android Studio projects and cannot be produced in a Linux sandbox.

---

## 2. App icons & splash
- Put a 1024×1024 PNG app icon + splash source in `resources/` and run
  `@capacitor/assets` (or set them manually in Xcode's Assets and Android's
  mipmap). Use the trimmed ResiWALK logo on a white background.

---

## 3. Camera & permissions (critical for inspections)
The web app uses the camera (`getUserMedia`) and photo file inputs. Native
permission strings are required or the camera silently fails:

**iOS** — `ios/App/App/Info.plist`, add:
```xml
<key>NSCameraUsageDescription</key>
<string>ResiWALK uses the camera to capture inspection photos.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>ResiWALK lets you attach photos to inspections.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>ResiWALK can save inspection photos.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>ResiWALK can tag inspections with their location.</string>
```
**Android** — `android/app/src/main/AndroidManifest.xml`, ensure:
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

---

## 4. Custom URL scheme (for OAuth return — see OAUTH_WEBVIEW.md)
Register `resiwalk://` so the system-browser OAuth flow can hand control back.

**iOS** — Xcode → target → Info → URL Types → add scheme `resiwalk`.
**Android** — add an intent-filter to the main activity:
```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="resiwalk" android:host="auth-callback" />
</intent-filter>
```

---

## 5. Build & run on a device
```bash
npx cap open ios       # opens Xcode → select a device → Run
npx cap open android   # opens Android Studio → select a device → Run
```
**TEST CHECKLIST on a real device:**
- App launches and loads the live web app.
- Login: tapping "Continue with Google" opens the SYSTEM browser (not the
  webview), completes Google, and returns to the app authenticated.
  → If Google shows `disallowed_useragent`, implement OAUTH_WEBVIEW.md Part A.
- Camera capture works (in-app camera + "Phone cam" fallback).
- Photo upload, autosave, finalize (online) all work as on the website.
- Pinch-zoom and scrolling feel right; status bar doesn't overlap content.

---

## 6. iOS — App Store submission
1. In Xcode: set the Team (your Apple Developer account), a unique bundle id
   (`com.resihome.resiwalk`), and a marketing version.
2. Product → Archive → Distribute App → App Store Connect → Upload.
3. In **App Store Connect**: create the app, fill metadata, screenshots
   (6.7" + 5.5" iPhone at minimum), privacy questions (declare camera, and
   "data not collected for tracking" if accurate), and a privacy policy URL.
4. Submit for review. First reviews take ~24–72h.

> App Store note: Apple's guideline 4.2 can reject apps that are "just a website."
> Stage 0 mitigations: native camera integration, offline fallback screen, and a
> native splash. If 4.2 is raised, accelerate Stage 2 (offline reference caching)
> which adds clear native value. Position ResiWALK as a field tool for staff, not
> a repackaged consumer site.

---

## 7. Android — Play Store submission
1. Android Studio → Build → Generate Signed Bundle (AAB). Create/keep an upload
   keystore (back it up — losing it blocks future updates).
2. **Play Console**: create the app, complete the Data safety form (declare
   camera/photos), content rating, target audience, and a privacy policy URL.
3. Upload the AAB to the Internal testing track first; test; then promote to
   Production. Internal testing is near-instant; production review ~1–3 days.

---

## 8. Switching to resiwalk.com later
Once Google Safe Browsing clears resiwalk.com:
1. Edit `capacitor.config.ts` → `server.url = 'https://resiwalk.com'`.
2. `npx cap sync`, rebuild, ship an app update.
No store re-review of the concept is needed — it's a normal version update.

---

## 9. What Stage 0 does NOT include (future stages)
- No offline capture (Stage 2–3). The app requires connectivity; the offline
  screen only appears when unreachable.
- No local SQLite / outbox / sync.
- No bundled web assets — the shell always loads the live Vercel app.
See PATH_B_ANALYSIS.md, Phase 7 for the staged path to full offline.
