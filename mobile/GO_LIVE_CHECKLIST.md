# ResiWALK native — go-live checklist

The native apps are thin Capacitor shells that load the LIVE web app via
`server.url`. So **web features ship by deploying `main` to Vercel** — no native
rebuild needed. A native rebuild is only required for the items below (shell
config, permissions, branding, store metadata).

## ✅ Ready now (verified on `chore/native-oauth-outbound`)
- **Android project** (`mobile/android`): builds as a shell.
- **Permissions** (`AndroidManifest.xml`): INTERNET, CAMERA, RECORD_AUDIO,
  MODIFY_AUDIO_SETTINGS, ACCESS_FINE/COARSE_LOCATION + camera/gps/mic features.
- **Camera/mic seamlessness:** Capacitor auto-grants in-webview getUserMedia after
  the one-time OS prompt (see `CAMERA_MIC_PERMISSIONS.md`). One prompt, then never.
- **OAuth:** Google sign-in diverts to the system browser and returns via the
  `resiwalk://auth-callback` deep link (`MainActivity.java` + intent-filter).
- **Branding:** pink (`#ff0060`) launcher icons + splash; SplashScreen bg matches.
- **allowNavigation:** resiwalk.com, www.resiwalk.com, the Vercel URL.
- **iOS scaffold** (`ios-pending/`): WebViewController (media auto-grant + OAuth),
  Info.plist additions, step-by-step build README. `@capacitor/ios` dep present.

## ⛳ Decisions / remaining work before store submit
1. **`server.url` → `https://resiwalk.com`** (ONE line in `capacitor.config.ts`,
   then `npx cap sync`). Currently the Vercel URL. Flip this ONLY once
   resiwalk.com has cleared Google Safe Browsing (otherwise the app loads a
   warning page). This is the single most important go-live toggle — confirm
   Safe Browsing status first. allowNavigation already lists resiwalk.com.
   - Keep `PUBLIC_APP_ORIGIN=https://resiwalk.com` set on Vercel so the
     `resiwalk_inspection_url` links match the domain the apps load.
2. **iOS build** — follow `ios-pending/README.md` on a Mac (generate, add the
   WebViewController, Info.plist, icon/splash, sign, TestFlight).
3. **Android release build** — Android Studio (Gradle JDK = embedded JBR 21),
   bump versionCode/versionName, signed AAB → Play Console (internal testing first).
4. **Store metadata** — privacy policy URL, camera/mic/location usage justifications
   (matches the in-app inspection use), screenshots, app description.
5. **Real-device smoke test** (both platforms): first-run camera/mic prompt is
   one-time; photo + video capture; pinch-to-zoom zooms the camera (not the page);
   GPS evidence stamp; Google sign-in round-trips via `resiwalk://`; an inspection
   loads from a `resiwalk_inspection_url` link.

## Reminder
Per `CLAUDE.md`: never change `server.url` casually; native-only work stays on
`chore/native-oauth-outbound` until native + web are merged.
