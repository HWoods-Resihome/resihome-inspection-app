# Native push notifications (FCM) — setup runbook

The native shell delivers push via **Firebase Cloud Messaging (FCM)** using
`@capacitor/push-notifications`. The web app (loaded via `server.url`) registers
the device token and posts it to the server; the server (`lib/pushSender` +
`lib/fcmSender` on `main`) sends through FCM. This file is the one-time native
setup; everything else is already wired.

## What's already done (this branch)
- `@capacitor/push-notifications` added to `mobile/package.json` and synced into
  the Android project (`npx cap sync android` — registers the plugin in
  `capacitor.settings.gradle` / `capacitor.build.gradle`).
- `POST_NOTIFICATIONS` permission added to `AndroidManifest.xml` (Android 13+).
- Gradle is already google-services-ready: `mobile/android/build.gradle` has the
  `com.google.gms:google-services` classpath, and `app/build.gradle` applies the
  plugin **only if `google-services.json` is present** (so the build doesn't
  break before you add it).
- The web registration bridge ships on `main` (`lib/nativeBridge` →
  `installPushBridge`): it requests permission, registers, and POSTs the token to
  `/api/push/subscribe` with `{ platform: 'native' }`. No-op in a browser.

## What YOU need to do (the Firebase parts)
1. **Create a Firebase project** (or reuse one) at https://console.firebase.google.com.
2. **Add an Android app** with package name `com.resihome.resiwalk`. Download the
   generated **`google-services.json`** and drop it into:
   `mobile/android/app/google-services.json`
   (git-ignored by default — don't commit it).
3. **Service account for the server**: Firebase → Project settings → Service
   accounts → *Generate new private key*. Paste the full JSON into the Vercel
   env var **`FCM_SERVICE_ACCOUNT_JSON`** (Production). That's what
   `lib/fcmSender` uses to call the FCM v1 API.
4. Rebuild: `cd mobile && npm install && npx cap sync android`, open
   `mobile/android` in Android Studio, Build → Make Project, run on a device.

## Verify
- Launch the app on a real device, accept the notification prompt.
- Confirm a `push-subs/.../*.json` blob appears (server stores the token) — or
  check the server log for `[push]`.
- Have a *second* reviewer approve an inspection you submitted → you get a push.
  (Inspector ≠ approver, first approval only — same rule as web push.)

## Notes
- iOS later: add an iOS app in Firebase, drop `GoogleService-Info.plist`, enable
  Push capability + APNs key. The web bridge + server already handle `'native'`
  tokens platform-agnostically.
- The token is re-registered on every launch (idempotent server-side), and dead
  tokens self-prune when FCM returns `UNREGISTERED`.
