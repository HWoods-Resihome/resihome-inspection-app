# OAuth-pending — DO NOT DEPLOY YET

This folder holds the **native OAuth-return fix** for the Capacitor app, parked
here on purpose. It is **NOT applied** to the live web app in this zip.

## Why it's parked
This is v0.21.9 of the web app — the safe, tested bug-fix release (1099 submit
fix, PDF photo overhang, zip code, mobile address wrapping, code-review
hardening). It deploys to production normally via `refresh.ps1`.

The native OAuth fix is a **separate, untested change** that must be verified on
the Android emulator BEFORE it goes live (see `NATIVE_OAUTH_RETURN.md` →
"Human-only steps"). Shipping it to production blind would risk the login flow.

This whole folder lives under `mobile/`, which is in `.vercelignore`, so Vercel
**never builds or sees it**. Deploying this zip ships only the safe v0.21.9 web
fixes. The OAuth code rides along in the repo, inert, until you're ready.

## What's here
- `NATIVE_OAUTH_RETURN.md` — the full design, security notes, test plan, and the
  human-only steps (Google redirect URI, temporary server.url, cap sync).
- `web-changes/` — the exact web files to apply when ready:
  - `lib/auth.ts`            → replace `lib/auth.ts` (adds exchange-token helpers)
  - `lib/nativeBridge.ts`    → new file at `lib/nativeBridge.ts`
  - `middleware.ts`          → replace `middleware.ts` (adds /api/auth/exchange public path)
  - `pages/_app.tsx`         → replace `pages/_app.tsx` (installs the gated bridge)
  - `pages/api/auth/exchange.ts`     → new file at `pages/api/auth/exchange.ts`
  - `pages/api/auth/gmail-callback.ts` → replace `pages/api/auth/gmail/callback.ts`
    (NOTE: renamed with a dash here only to keep this flat folder simple — it
    goes back to `gmail/callback.ts`)
  - `pages/api/auth/google-login.ts` → replace `pages/api/auth/google-login.ts`
- `AndroidManifest.xml` — the edited manifest (resiwalk:// intent-filter + CAMERA);
  drop into `mobile/android/app/src/main/AndroidManifest.xml` after you generate
  the native project with `npx cap add android`.

## When you're ready to enable OAuth (do this on a BRANCH, not main)
1. Read `NATIVE_OAUTH_RETURN.md` and complete the human-only steps first
   (Google redirect URI, temporary server.url, emulator test).
2. On a branch `feat/native-oauth-return`:
   - Copy the `web-changes/` files into their real locations (see list above).
   - Add to root `package.json` dependencies:
     ```
     "@capacitor/core": "^6.1.2",
     "@capacitor/app": "^6.0.1",
     "@capacitor/browser": "^6.0.3"
     ```
   - Apply the Android manifest change.
3. `npm install`, `npm run build` to confirm it compiles.
4. Test on the emulator per the doc. Only after it passes do you merge/deploy.

Until then: deploying this zip is safe and ships only v0.21.9.
