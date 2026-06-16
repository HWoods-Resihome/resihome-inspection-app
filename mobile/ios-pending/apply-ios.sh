#!/usr/bin/env bash
# Apply the parked iOS native files into the generated Capacitor project
# (mobile/ios). IDEMPOTENT — safe to re-run; CI runs it every build as a guard.
#
# NATIVE-ONLY: this touches only mobile/ios (the generated Xcode project). It does
# NOT modify anything the web app deploys. Run AFTER `npx cap add ios && npx cap
# sync ios`.
#
# What it does:
#   1. Copies WebViewController.swift into the App target (camera/mic auto-grant
#      + OAuth->Safari) and registers it in project.pbxproj so it compiles.
#   2. Points the Main.storyboard bridge VC at WebViewController.
#   3. Merges the required Info.plist usage strings + the resiwalk:// URL scheme.
#   4. Drops the fastlane config next to the Xcode project.
#
# NOTE on the geolocation bridge: that is a WEB change (web-changes/lib/
# geolocationBridge.ts) that only takes effect once it's live on the web app at
# server.url — the Stage-0 shell loads the live site, so it is intentionally NOT
# applied to the native build here (it would be a no-op in the binary anyway).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PENDING="$ROOT/mobile/ios-pending"
IOS_APP="$ROOT/mobile/ios/App"
APP_SRC="$IOS_APP/App"
PLIST="$APP_SRC/Info.plist"
STORYBOARD="$APP_SRC/Base.lproj/Main.storyboard"
PBXPROJ="$IOS_APP/App.xcodeproj/project.pbxproj"

if [ ! -d "$APP_SRC" ]; then
  echo "ERROR: $APP_SRC not found — run 'npx cap add ios' first." >&2
  exit 1
fi

echo "==> [1/4] WebViewController.swift -> App target"
cp "$PENDING/WebViewController.swift" "$APP_SRC/WebViewController.swift"
ruby "$PENDING/add_to_xcodeproj.rb" "$PBXPROJ" "WebViewController.swift"

echo "==> [2/4] Storyboard bridge VC -> WebViewController"
if grep -q 'customClass="WebViewController"' "$STORYBOARD"; then
  echo "   already set"
elif grep -q 'customClass="CAPBridgeViewController"' "$STORYBOARD"; then
  /usr/bin/sed -i '' \
    's#customClass="CAPBridgeViewController"#customClass="WebViewController" customModule="App" customModuleProvider="target"#g' \
    "$STORYBOARD"
  echo "   set customClass=WebViewController"
else
  echo "   WARN: bridge VC customClass not found in $STORYBOARD — verify manually." >&2
fi

echo "==> [3/4] Info.plist usage strings + URL scheme"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST"; }
add_str() {
  pb "Print :$1" >/dev/null 2>&1 || pb "Add :$1 string $2"
}
add_str "NSCameraUsageDescription" "ResiWALK uses the camera to photograph and record inspection evidence."
add_str "NSMicrophoneUsageDescription" "ResiWALK uses the microphone for voice call-outs during inspections."
add_str "NSLocationWhenInUseUsageDescription" "ResiWALK stamps inspection photos with the property location to verify you're on site."

if ! pb "Print :CFBundleURLTypes" >/dev/null 2>&1; then
  pb "Add :CFBundleURLTypes array"
  pb "Add :CFBundleURLTypes:0 dict"
  pb "Add :CFBundleURLTypes:0:CFBundleURLName string com.resihome.resiwalk"
  pb "Add :CFBundleURLTypes:0:CFBundleURLSchemes array"
  pb "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string resiwalk"
  echo "   added resiwalk:// URL scheme"
elif pb "Print :CFBundleURLTypes" | grep -q "resiwalk"; then
  echo "   resiwalk:// URL scheme already present"
else
  # CFBundleURLTypes exists but ours isn't there — append a new entry.
  n="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' "$PLIST" | grep -c 'Dict {' || true)"
  pb "Add :CFBundleURLTypes:$n dict"
  pb "Add :CFBundleURLTypes:$n:CFBundleURLName string com.resihome.resiwalk"
  pb "Add :CFBundleURLTypes:$n:CFBundleURLSchemes array"
  pb "Add :CFBundleURLTypes:$n:CFBundleURLSchemes:0 string resiwalk"
  echo "   appended resiwalk:// URL scheme"
fi

echo "==> [4/4] fastlane config -> $IOS_APP/fastlane"
mkdir -p "$IOS_APP/fastlane"
cp "$PENDING/fastlane/Fastfile" "$IOS_APP/fastlane/Fastfile"
cp "$PENDING/fastlane/Appfile" "$IOS_APP/fastlane/Appfile"

echo "==> apply-ios.sh complete"
