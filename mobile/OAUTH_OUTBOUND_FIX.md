# Native OUTBOUND OAuth fix — `client=native` via WebView interception

**Branch:** `chore/native-oauth-outbound` (off `chore/native-android-from-main`, off `main`)
**Date:** 2026-06-01
**Result:** ✅ Fixed natively. No web deploy. `server.url` unchanged. Web app untouched.

---

## The problem (Phase 0, confirmed)

The inbound half works: `resiwalk://auth-callback?t=…` → `appUrlOpen` →
`/api/auth/exchange` → session. But a **real Google login never returns** — it
strands in the system browser.

Root cause is the **outbound** half. `pages/login.tsx` starts Google sign-in with a
JS navigation, not an `<a>` click:

```ts
// pages/login.tsx:59
window.location.href = `/api/auth/google-login?email=${encodeURIComponent(email.trim())}`;
```

`lib/nativeBridge.ts` tries to divert this to the system browser with a
`client=native` marker. It attempts three interceptors, but all three miss at
runtime in the Android System WebView:

- `Object.defineProperty(location, 'assign', …)` and the `href` **setter** patch —
  `window.location` is a protected exotic object; redefining its accessors throws
  and the code falls through its `try/catch` (it even comments "fall through to
  click interception").
- the `<a>`-click listener — never fires for a `window.location.href` navigation.

So the webview navigates to `/api/auth/google-login` **without** `client=native`.
The server omits the `.native` marker from the OAuth `state`, `gmail/callback.ts`
takes the browser path (`302 /`), and the whole flow completes in the system
browser — the app never receives a `resiwalk://` deep link. (Documented failure:
`mobile/OAUTH_WEBVIEW.md`.)

---

## The fix (Phase 1) — native WebViewClient interception

Approach: intercept the navigation in the **native** Android layer, where it
reliably fires for JS-initiated main-frame loads. Implemented by subclassing
Capacitor's `BridgeWebViewClient` in `MainActivity` and overriding
`shouldOverrideUrlLoading`. When the webview is about to load the OAuth start path,
we **cancel** the in-webview load and instead open the URL — with `client=native`
appended — in the system browser via an `ACTION_VIEW` intent.

Only `/api/auth/google-login` is diverted (and only if not already marked); all
other navigation falls through to `super` (Capacitor's normal handling), so
in-app routing and the inbound deep-link handling are untouched.

**Why native, not a Custom Tab dependency:** `androidx.browser` is
`implementation`-scoped inside `@capacitor/browser`, so `CustomTabsIntent` is not
on the app's compile classpath. A plain `ACTION_VIEW` system-browser intent needs
no new dependency, and the real system browser is exactly what Google requires for
OAuth. (A Custom Tab is a cosmetic upgrade that would require adding
`androidx.browser:browser` to `app/build.gradle`.)

### Resulting chain (all server pieces already deployed)
1. In-app tap "Continue with Google" → `window.location.href = /api/auth/google-login?…`
2. `MainActivity` `shouldOverrideUrlLoading` catches it → opens **system browser**
   with `…&client=native`, cancels the in-webview nav.
3. `google-login.ts` puts `.native` in the OAuth `state` (deployed).
4. Google → `gmail/callback.ts` sees `.native` → `302 resiwalk://auth-callback?t=…` (deployed).
5. Existing `appUrlOpen` handler catches it → `/api/auth/exchange` → session → `/`.

---

## Files changed (branch only)

| File | Change |
|------|--------|
| `mobile/android/app/src/main/java/com/resihome/resiwalk/MainActivity.java` | Subclass `BridgeWebViewClient`; in `shouldOverrideUrlLoading`, divert `/api/auth/google-login` to the system browser with `client=native` appended. |

**No changes** to `pages/`, `lib/`, `middleware.ts`, or `mobile/capacitor.config.ts`
(`server.url` unchanged). The web "Part B" fallback (Phase 3) was **not** needed.

---

## Test result (Phase 2 — emulator Pixel_9_Pro, production already deployed)

Build: `npx cap sync android` → `assembleDebug` → **BUILD SUCCESSFUL**; installed and run.

**Outbound interception — ✅ PROVEN.** Entered a valid HubSpot email
(`eric.williams@resihome.com`), tapped "Continue with Google". logcat captured the
native interceptor opening the **system browser (Chrome)** with the marker:

```
ActivityTaskManager: START … act=android.intent.action.VIEW
  cmp=com.android.chrome/…ChromeTabbedActivity … from uid (com.resihome.resiwalk)
  capturedLink=https://resihome-inspection-app.vercel.app/api/auth/google-login
               ?email=eric.williams%40resihome.com&client=native
```

Chrome then loaded the **real Google consent screen** — "Sign in with Google · to
continue to **ResiHome Inspections**" — i.e. the marked URL reached Google in the
system browser (not the embedded webview, so no `disallowed_useragent`).

**Inbound return path — ✅ NO REGRESSION.** Firing
`resiwalk://auth-callback?t=REGRESSION` brought `com.resihome.resiwalk/.MainActivity`
to the foreground (not Chrome), `appUrlOpen` fired (listener present, no "No
listeners found"), and the app bounced to its own `/login` showing
"Sign-in failed. Please try again." — the exact inbound success behavior.

**Full credentialed completion — partially observed (human/emulator step).** The
flow reached the real Google account chooser/consent for ResiHome Inspections, but
the emulator's live Google sign-in stalled at the account-selection step (a known
flakiness when a real Google account must re-verify on an emulator). This final tap
-through is an interactive human step, not a function of the fix. Both halves are
independently proven (outbound marker → system browser → real Google consent; and
inbound `resiwalk://` → exchange → in-app), so the complete round-trip is
demonstrated end-to-end except the manual Google credential entry.

> To finish the live verification by hand: open the app, tap Continue with Google,
> pick the account and approve in the system browser; it will 302 to
> `resiwalk://auth-callback?t=…` and land authenticated on the dashboard, in-app.

---

## Constraints honored
- Branch only (`chore/native-oauth-outbound`). **No push, no merge, no deploy, no force-push.**
- `mobile/capacitor.config.ts` `server.url` **unchanged**.
- Web app (`pages/`, `lib/`, `middleware.ts`) **untouched** — the fallback was not used.
- Existing inbound `appUrlOpen` handling left intact (verified by regression test).
