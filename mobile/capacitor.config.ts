import type { CapacitorConfig } from '@capacitor/cli';

// ResiWALK — Stage 0 native shell.
//
// Stage 0 strategy: the native app is a thin shell that loads the LIVE web app
// (already running on Vercel) inside the system webview via `server.url`. There
// is NO bundled web build and NO app-logic change — the web app stays exactly
// as deployed. This gets ResiWALK into the App Store / Play Store immediately
// and validates native packaging, camera permissions, and store review before
// any offline work begins (see PATH_B_ANALYSIS.md, Phase 7, Stage 0).
//
// When resiwalk.com clears Google Safe Browsing review, change `server.url`
// to https://resiwalk.com and re-run `npx cap sync`. Until then we point at the
// working Vercel URL (the native shell has no address bar, so the domain is
// invisible to end users anyway).
//
// IMPORTANT — OAuth: Google blocks OAuth inside embedded webviews
// ("disallowed_useragent"). Sign-in must open in the SYSTEM browser and return
// via the custom URL scheme below. See OAUTH_WEBVIEW.md.

const config: CapacitorConfig = {
  appId: 'com.resihome.resiwalk',
  appName: 'ResiWALK',
  // No local web assets are bundled in Stage 0; `www/` holds only a fallback
  // page shown if the device is offline at launch (server.url unreachable).
  webDir: 'www',
  server: {
    // The live web app. Switch to https://resiwalk.com after Safe Browsing clears.
    url: 'https://resihome-inspection-app.vercel.app',
    // Allow the webview to navigate to these hosts without treating them as
    // external (so in-app navigation stays in the webview). OAuth hosts are
    // intentionally NOT here — those open in the system browser.
    allowNavigation: [
      'resihome-inspection-app.vercel.app',
      'resiwalk.com',
      'www.resiwalk.com',
    ],
    // iOS: required so the webview will load an https origin as the app origin.
    iosScheme: 'https',
    androidScheme: 'https',
  },
  ios: {
    contentInset: 'always',
    // Allow the in-app camera (getUserMedia) and file inputs.
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#ff0060',
      showSpinner: false,
    },
  },
};

export default config;
