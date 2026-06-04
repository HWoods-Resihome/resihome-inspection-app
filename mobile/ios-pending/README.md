# iOS native shell — ready-to-build scaffold

The iOS app is the same thin Capacitor shell as Android: it loads the LIVE web
app via `server.url` (see `mobile/capacitor.config.ts`). Everything here is
prepared so the only remaining work is generating + building the project **on a
Mac with Xcode** (Capacitor can't generate the iOS project off macOS).

`@capacitor/ios` is already a dependency; the config (`capacitor.config.ts`) is
shared with Android and already correct (`iosScheme: https`,
`limitsNavigationsToAppBoundDomains: false` so getUserMedia works,
`allowNavigation` includes resiwalk.com).

## Steps (on macOS, Xcode installed)
1. Generate + sync the project:
   ```
   cd mobile
   npm install
   npx cap add ios
   npx cap sync ios
   ```
2. **Camera/mic auto-grant + OAuth diversion:** copy `WebViewController.swift`
   into `ios/App/App/`, then in `ios/App/App/Base.lproj/Main.storyboard` select
   the Bridge View Controller and set **Custom Class → `WebViewController`**
   (Module: `App`). This makes camera/mic a single one-time prompt (no repeat
   in-app prompts) and sends Google sign-in to Safari, returning via
   `resiwalk://auth-callback` — mirroring Android.
3. **Permissions + URL scheme:** merge `Info.plist.additions.xml` into
   `ios/App/App/Info.plist` (camera / mic / location usage strings + the
   `resiwalk` URL scheme). Required or iOS kills the app on first use.
4. **Branding:** set the app icon + splash to the pink (`#ff0060`) ResiWALK mark.
   Easiest: `npx @capacitor/assets generate --ios` from a 1024px icon + splash,
   or drop them into the Xcode asset catalog. SplashScreen bg is already `#ff0060`
   in `capacitor.config.ts`.
5. **Signing:** open `ios/App/App.xcworkspace` in Xcode, set the Team + bundle id
   `com.resihome.resiwalk`, then Product → Archive → distribute to TestFlight.

## Go-live note
`server.url` is shared with Android. Confirm the **`https://resiwalk.com` switch**
(see `mobile/GO_LIVE_CHECKLIST.md`) before the store build so iOS and Android ship
pointing at the same canonical domain.

## Files here
- `WebViewController.swift` — `CAPBridgeViewController` subclass: media auto-grant + OAuth→Safari.
- `Info.plist.additions.xml` — usage strings + `resiwalk` URL scheme to merge.
