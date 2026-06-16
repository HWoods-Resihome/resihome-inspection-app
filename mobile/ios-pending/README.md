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

## GPS evidence stamp — geolocation bridge (REQUIRED on iOS)
The in-app camera burns a GPS evidence stamp (and a ✓/✗ on-site proximity check)
using the web **`navigator.geolocation`** API (see `components/CameraCapture.tsx`).
Android WebView supports that API, but a plain **WKWebView does NOT bridge
`navigator.geolocation` to CoreLocation** — so without this, the iOS stamp reads
"unverified" and the proximity check never evaluates, even though
`NSLocationWhenInUseUsageDescription` is set (that string only covers the OS
prompt, not the JS API).

This is now **wired** via `@capacitor/geolocation` (already added to
`mobile/package.json`) plus a native-iOS-gated shim that swaps
`navigator.geolocation` for the plugin. To apply it (do it together with the
OAuth native web-changes — both are gated no-ops in a normal browser):

1. Copy `web-changes/lib/geolocationBridge.ts` → `lib/geolocationBridge.ts` in the
   web app.
2. Add `"@capacitor/geolocation": "^6.0.0"` to the **root** `package.json`
   dependencies (the web app imports it; it's dynamically imported + gated, so it
   stays out of the browser bundle's critical path).
3. In `pages/_app.tsx`, call it at startup next to the OAuth bridge:
   ```ts
   import { installGeolocationBridge } from '@/lib/geolocationBridge';
   useEffect(() => { void installOAuthBridge(); void installGeolocationBridge(); }, []);
   ```
4. `cd mobile && npm install && npx cap sync ios` (registers the plugin in the iOS
   project). The plugin reads `NSLocationWhenInUseUsageDescription` from Info.plist.
5. **Verify on TestFlight:** open the camera — the stamp should show a real
   address/coords + distance, and the ✓/✗ proximity verdict should appear.

The camera/mic auto-grant is independent of this and unaffected either way.

## Files here
- `WebViewController.swift` — `CAPBridgeViewController` subclass: media auto-grant + OAuth→Safari.
- `Info.plist.additions.xml` — usage strings + `resiwalk` URL scheme to merge.
- `web-changes/lib/geolocationBridge.ts` — native-iOS `navigator.geolocation` shim
  over `@capacitor/geolocation` (the GPS evidence-stamp fix above).

