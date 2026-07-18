# Native shell — pre-mass-rollout TODO (apply on `chore/native-oauth-outbound`)

The full-app audit found native-shell parity gaps that **silently break core
features on a real device** (they can't be verified from `main`, where the native
Android/iOS project isn't checked out). Apply these on the native branch, then
`cd mobile && npx cap sync android`, rebuild, and real-device test.

The reference manifest in this repo (`mobile/oauth-pending/AndroidManifest.xml`)
has already been updated to show the target permission set — mirror it into the
live `mobile/android/app/src/main/AndroidManifest.xml`.

## BLOCKER — Android manifest permissions

The web app now uses mic + GPS heavily; the shipped manifest was CAMERA + INTERNET
only. Add:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

- **RECORD_AUDIO / MODIFY_AUDIO_SETTINGS** — without these, `getUserMedia({audio})`
  is OS-denied: the AI camera (`CameraAILayer`), voice line assistant
  (`VoiceLineAssistant`), Live Room Scan (`LiveRoomScan`), the KB trainer, and
  video-with-audio capture all fail or record silence, with **no permission
  prompt**.
- **ACCESS_FINE/COARSE_LOCATION** — `navigator.geolocation` (the evidence stamp /
  services geofence, `lib/evidenceStamp.getGeoFix`) returns null without these, so
  every photo stamps **"Location unverified"** and the on-site proximity proof
  never renders. `lib/nativeBridge.primeLocationPermissionNative()` already expects
  the manifest permission to exist so the OS sheet appears at launch.

## iOS (`Info.plist`) — usage strings (required or the app is rejected/crashes)

```
NSMicrophoneUsageDescription  = "ResiWalk uses the microphone for voice-assisted
                                 line entry and the AI inspection camera."
NSLocationWhenInUseUsageDescription = "ResiWalk stamps inspection/service photos
                                 with your location to verify on-site work."
```
(Camera usage string should already be present.)

## HIGH — Native push plugin not declared

`lib/nativeBridge.installPushBridge()` dynamically imports
`@capacitor/push-notifications`, but it isn't in `mobile/package.json`, so the
import throws and push registration silently no-ops → approval/dispatch pushes
never reach the installed app.

- Add `@capacitor/push-notifications` to `mobile/package.json`, `npx cap sync
  android`, wire the FCM config (`google-services.json`) + APNs.
- If push is **out of scope** for launch, that's fine — just know the bridge call
  is currently dead code (no crash, just no push).

## Verified OK (no change needed)

- `capacitor.config.ts` `server.url` (Vercel URL) + `allowNavigation` — adequate;
  no new external host is required by the web code.
- Deep-link OAuth return `resiwalk://auth-callback` matches `nativeBridge` +
  `/api/auth/exchange`.
- Vendor email+password login is reachable in-webview (only Google/Microsoft OAuth
  starts divert to the system browser), and the daily vendor re-login persists
  (the session cookie sets both Max-Age and an explicit Expires).

## After applying

1. `cd mobile && npm install && npx cap sync android`
2. Real-device test: AI camera mic, voice line entry, an evidence-stamped photo
   (should show live GPS + "At property", not "Location unverified"), the
   `resiwalk://` Google-login return, and a vendor email/password sign-in.
