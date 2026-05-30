# OAuth inside the Capacitor webview — the one real Stage 0 risk

## The problem
The login flow does a full-page redirect to Google
(`/api/auth/google-login` → `accounts.google.com` → `/api/auth/gmail/callback`).
**Google blocks OAuth inside embedded webviews** and returns
`403 disallowed_useragent`. So a naive Stage 0 shell (webview only) will let users
load the app and type their email, but the Google step will fail.

This is a well-known constraint, not a bug in the app. The fix is to run the
Google step in the **system browser** (Safari/Chrome), not the embedded webview,
and return to the app via a custom URL scheme (deep link).

## The fix (two parts)

### Part A — native shell (no web app change)
1. Add `@capacitor/browser` (already in `package.json`) and `@capacitor/app`.
2. Register a custom URL scheme `resiwalk://` on both platforms (see
   BUILD_RUNBOOK.md → "URL scheme").
3. In the shell's small bootstrap script (injected, or via a tiny native
   listener), intercept navigations to `/api/auth/google-login` and instead open
   that URL with `Browser.open(...)`. When the system browser finishes the OAuth
   round-trip, the final callback redirect targets `resiwalk://auth-callback`,
   which the OS hands back to the app via the `appUrlOpen` event; the app then
   loads the authenticated home route in the webview.

### Part B — minimal web app change (one conditional redirect)
The web app's callback currently 302s to `/` after minting the session. For the
native flow we need it to optionally 302 to the app's custom scheme so the system
browser hands control back to the app. This is a SMALL, ADDITIVE change — it does
not affect the existing web behavior:

- When the OAuth flow was started from the native app, carry a marker (e.g.
  `?client=native`) through the `state` so `gmail/callback.ts` knows to finish by
  redirecting to `resiwalk://auth-callback` instead of `/`.
- The session cookie still gets set on the Vercel domain; because the webview
  shares the system cookie store on iOS (and we use the same origin), the
  authenticated session is present when the webview reloads. (On Android, if the
  webview cookie store is isolated, fall back to passing a short-lived one-time
  token on the deep link that the web app exchanges for the session — documented
  as the Android variant below.)

> This is the ONLY web-app code change Stage 0 may require, and only if testing
> shows the webview can't complete OAuth via the system browser without it. Build
> the shell first and TEST: some setups complete the round-trip with cookies
> alone and need no web change. Do not make the web change preemptively.

## Test order (do this before writing any web change)
1. Build the shell pointing at the live URL.
2. Try to log in. If Google shows `disallowed_useragent`, Part A is required.
3. With Part A (system browser), if the app returns authenticated → DONE, no web
   change needed.
4. Only if the session doesn't carry back into the webview → apply Part B
   (and the Android one-time-token variant if Android specifically fails).

## Android cookie variant (only if needed)
If the Android webview's cookie jar is isolated from the system browser:
- After minting the session, `gmail/callback.ts` issues a short-lived (60s),
  single-use token tied to the session and redirects to
  `resiwalk://auth-callback?t=<token>`.
- The app opens the webview to `/api/auth/exchange?t=<token>`, which validates the
  token and sets the session cookie in the webview's own jar, then redirects to `/`.
- This new `exchange` endpoint would be the only net-new server route — additive,
  gated, single-use, short TTL.
