# Native OAuth return — implementation summary

**Branch:** `feat/native-oauth-return` (committed locally only — **not merged, not deployed**)
**Status:** code complete + `next build` passes. Awaiting human-only steps (below) to test.

---

## What this fixes
Android testing showed Google login *works* (it opens in the system browser, so it
isn't blocked by `disallowed_useragent`), but after auth the session cookie lands
in **Chrome's** cookie jar and control never returns to the app. The user is left
in Chrome, and the app's webview (a separate cookie jar) is never authenticated.

This change adds the deep-link return + cookie-jar bridge from
`mobile/OAUTH_WEBVIEW.md` (the "Android cookie variant"): after Google succeeds,
the app is handed a short-lived token via `resiwalk://auth-callback?t=…`, and the
app exchanges it **inside its own webview** for the real session cookie.

```
Login (app webview)
  └─ taps "Continue with Google"
       └─ bridge opens /api/auth/google-login?...&client=native in SYSTEM browser
            └─ Google consent → /api/auth/gmail/callback
                 ├─ mints session (as today)
                 └─ native? → mints <=60s exchange token
                      └─ 302 resiwalk://auth-callback?t=<token>
                           └─ OS reactivates the app (singleTask)
                                └─ bridge's appUrlOpen → loads
                                   /api/auth/exchange?t=<token> in APP webview
                                     └─ sets resihome_session cookie in webview jar
                                          └─ 302 / (authenticated, inside the app)
```

Browser users never hit any of this — every web change is gated behind
`Capacitor.isNativePlatform()` or the `client=native` state marker.

---

## Files changed (branch only)

### Web app — additive + gated
| File | Change |
| --- | --- |
| `package.json` | Added `@capacitor/core/app/browser ^6` (see version note below). |
| `lib/nativeBridge.ts` | **New.** Gated bridge: no-op in browsers. On native, routes the `google-login` navigation through the system browser with `client=native`, and on the `resiwalk://auth-callback` deep link loads `/api/auth/exchange?t=…` in the app webview. |
| `pages/_app.tsx` | Calls `installOAuthBridge()` in a `useEffect` (gated internally; no browser effect). |
| `pages/api/auth/google-login.ts` | If `?client=native`, appends a `.native` marker to the OAuth `state` (rides the Google round-trip; cookies/query don't). |
| `pages/api/auth/gmail/callback.ts` | Reads the marker. Browser path: **unchanged** (302 `/`). Native path: mints a `<=60s` exchange token and 302s to `resiwalk://auth-callback?t=…`. |
| `lib/auth.ts` | **New helpers** `createOAuthExchangeToken` / `verifyOAuthExchangeToken` — jose HS256, reuse `SESSION_SECRET`, `typ:'oauth_exchange'`, `<=60s` TTL. |
| `pages/api/auth/exchange.ts` | **New.** GET `?t=<token>` → validate → set the same `resihome_session` cookie → 302 `/`. Invalid/expired → 302 `/login`, no session. |
| `middleware.ts` | `/api/auth/exchange` added to `PUBLIC_PATHS` (reachable pre-session). |

### Native — Android shell
| File | Change |
| --- | --- |
| `mobile/android/app/src/main/AndroidManifest.xml` | Added the `resiwalk://auth-callback` `<intent-filter>` (VIEW + DEFAULT + BROWSABLE) to `MainActivity`, and `CAMERA` permission + camera `uses-feature` (INTERNET already present). `launchMode="singleTask"` was already set. |

**`appUrlOpen` handling:** done via the **web bootstrap** (`@capacitor/app` listener in
`lib/nativeBridge.ts`), not a native `MainActivity` hook. `singleTask` ensures the
deep link reactivates the existing activity, and the bundled bridge catches the
event. No Java/Kotlin change was needed.

---

## Version-skew decision (deviation from the brief)
The brief said root `package.json` pins `@capacitor/core ^8` and to "align DOWN to
6." **In this codebase that premise was false:** root had **no** Capacitor deps and
the web app imported **zero** Capacitor APIs (verified by grepping
`pages/ lib/ components/`). So there was nothing to downgrade. The correct action
was **additive**: add `@capacitor/core/app/browser` at `^6.x` matching the shell
(`mobile/package.json`). The web app uses no Capacitor-8-only APIs, so no STOP
condition was triggered. `mobile/`'s versions and the generated `android/` project
were left untouched.

---

## Security properties of the exchange token
- Signed with the **existing** `SESSION_SECRET` via jose HS256 — no new long-lived secret.
- Distinct `typ:'oauth_exchange'`; the exchange endpoint re-checks `typ` before
  minting a session, so a session JWT can't be replayed here and vice-versa.
- `<=60s` TTL, HTTPS-only, carries only the identity the user just proved via Google
  (no privilege escalation — it mints exactly what a normal login would).
- **Residual risk (documented, intentional):** true single-use would need
  server-side state (a used-token store / KV). We did **not** add that infra. The
  remaining exposure is a `<=60s` replay window on a token that already encodes the
  same identity the user just authenticated. Acceptable for this stage; revisit if
  a KV/Redis is added later.

---

## HUMAN-ONLY steps (Claude Code cannot do these)

### 1. Google Cloud Console — add the test redirect URI
The Google OAuth client only knows the **production** callback. For any test target
you must add its callback or Google fails with `redirect_uri_mismatch`:
- Add `<TEST_ORIGIN>/api/auth/gmail/callback` as an **Authorized redirect URI**
  on the OAuth client.
- `resiwalk://auth-callback` does **not** go in Google — Google only ever redirects
  to the Vercel callback; the app scheme is the *server's* final redirect, not Google's.

### 2. Pick a test target + point `server.url` at it (do NOT commit this)
The committed `mobile/capacitor.config.ts` `server.url` stays as-is. For testing,
temporarily change it locally to one of:
- **(a) Vercel preview deploy of the branch** — cleanest. Requires pushing the
  branch to origin. **The `eric.williams` account may lack write access** (expected;
  see "Push" below). If you can deploy a preview, set `server.url` to the preview URL
  and add `<preview>/api/auth/gmail/callback` to Google (step 1).
- **(b) Local `next dev`** reachable from the Android emulator at
  `http://10.0.2.2:3000`: set `server.url` to that, temporarily allow cleartext
  (`android:usesCleartextTraffic="true"` or a network-security-config), and add
  `http://10.0.2.2:3000/api/auth/gmail/callback` to Google.

After editing config: `cd mobile && npx cap sync android`.

### 3. Build & verify on the emulator/device
1. Tap **Continue with Google** → opens the **system browser** (not the webview).
2. Complete Google → browser 302s to `resiwalk://auth-callback?t=…` → **app reactivates**.
3. App loads `/api/auth/exchange?t=…` → session set in the **webview jar** → lands on `/` authenticated.
4. The whole post-login experience is now **inside the app** — no Chrome address bar.
5. **Regression:** in a normal desktop/mobile browser, login still 302s to `/` exactly as before (no `client=native` marker → byte-for-byte unchanged).
6. Token safety: re-using an old `?t=` after 60s → bounced to `/login` with no session.

### 4. Push the branch (optional / may fail)
```
git push -u origin feat/native-oauth-return
```
If this fails with a permissions error, that's the expected `eric.williams`
write-access limitation — leave it committed locally and report. **Do not** force-push,
merge, or deploy to production.

---

## Confirmation
- Changes are on `feat/native-oauth-return` **only** — not merged, production untouched.
- All web-app changes are additive and gated; **browser-user behavior is unchanged**.
- No HubSpot schema/data, `.env` secrets, committed `server.url`, or unrelated code touched.
- `next build` passes. (Pre-existing `tsc --noEmit` strictness warnings in
  `lib/gmailAuth.ts`/`lib/hubspot.ts` are unrelated to this change and do not block
  `next build` — they exist on the baseline.)

## Risks flagged
- The brief's Capacitor-8 skew premise didn't match the repo (handled additively — see above).
- `appUrlOpen` is handled in the web bootstrap, not natively — if a specific device
  build doesn't surface the event to the webview, a small native `MainActivity`
  `onNewIntent` hook is the fallback (not needed in this implementation).
- Exchange token is short-TTL but not strictly single-use (documented above).
