# Deploying to Vercel — Step-by-Step Guide

This guide walks you through deploying v0.8 of the ResiHome Inspection App
to Vercel, pointed at the ResiTest sandbox (portal 51415639).

Estimated time: 20-30 minutes for first deploy.

---

## Prerequisites you need before starting

1. **A GitHub account** (or GitLab/Bitbucket — instructions below assume GitHub)
2. **A Vercel account** (signup at https://vercel.com — free)
3. **Git installed** on your Windows machine
   - Check with `git --version` in PowerShell
   - If missing, install from https://git-scm.com/download/win
4. **The values from your existing `.env.local`** — you'll need to paste these
   into Vercel's environment variables UI:
   - `HUBSPOT_SANDBOX_TOKEN` (your Private App token, starts with `pat-na1-`)
   - `HUBSPOT_INSPECTION_TYPE_ID` = 2-63142762
   - `HUBSPOT_INSPECTION_QUESTION_TYPE_ID` = 2-63142763
   - `HUBSPOT_INSPECTION_ANSWER_TYPE_ID` = 2-63142766
   - `HUBSPOT_PROPERTY_TYPE_ID` = 2-61770114
   - `SESSION_SECRET` (your generated 64-char hex string)

If you don't remember `SESSION_SECRET`, you can generate a new one — but
existing inspectors will be signed out when you do, since the old session
cookies will become invalid. For first deploy this is fine.

---

## Step 1: Create the GitHub repository

1. Go to https://github.com/new
2. Repository name: `resihome-inspection-app` (or whatever you prefer)
3. **Visibility**: PRIVATE (strongly recommended — even though there are
   no secrets in the code, keeping internal tools private is good hygiene)
4. Do NOT initialize with a README, .gitignore, or license
   (we have these locally already)
5. Click "Create repository"
6. Copy the repo URL from the next page (looks like
   `https://github.com/YourUsername/resihome-inspection-app.git`)

---

## Step 2: Initialize Git locally and push

Open PowerShell, navigate to the project folder:

```powershell
cd C:\Users\hwoods\Documents\inspection_app
```

Initialize Git and make first commit:

```powershell
git init
git add .
git status
```

The `git status` output should list all the files being added. **Critically**,
`.env.local` should NOT appear in the list — if it does, STOP and check your
`.gitignore`. The file should already protect it; if it doesn't, we have a
problem.

Confirm `.env.local` is NOT in the list, then:

```powershell
git commit -m "Initial commit - v0.8"
```

Set the main branch name and link to GitHub:

```powershell
git branch -M main
git remote add origin https://github.com/YourUsername/resihome-inspection-app.git
git push -u origin main
```

Replace `YourUsername` with your actual GitHub username. The first push will
prompt for GitHub credentials. If you've never used Git on this machine,
you may need to set up a Personal Access Token:
https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens

---

## Step 3: Verify the repo on GitHub

Refresh your GitHub repo page. You should see all the source files. Click
on a few to spot-check:

- `package.json` should be there with version 0.8.0
- `.env.local` should NOT be there
- `node_modules/` should NOT be there
- `README.md` should be there

If anything looks wrong, fix it locally and push again.

---

## Step 4: Connect to Vercel

1. Go to https://vercel.com/new
2. Click "Import Git Repository"
3. If this is your first time, you'll be prompted to install the Vercel
   GitHub app. Authorize it for the repository you just created (you can
   limit it to just this one repo, recommended).
4. Find your `resihome-inspection-app` repo in the list and click "Import"

---

## Step 5: Configure the project on Vercel

You'll see a project configuration screen.

**Framework Preset**: Should auto-detect as "Next.js". If not, select it.

**Root Directory**: Leave as the default (the repo root).

**Build and Output Settings**: Leave defaults.

**Environment Variables**: This is the important part. Add EACH of these:

| Name | Value | Environment |
|---|---|---|
| `HUBSPOT_SANDBOX_TOKEN` | `pat-na1-...` (your actual token) | All |
| `HUBSPOT_INSPECTION_TYPE_ID` | `2-63142762` | All |
| `HUBSPOT_INSPECTION_QUESTION_TYPE_ID` | `2-63142763` | All |
| `HUBSPOT_INSPECTION_ANSWER_TYPE_ID` | `2-63142766` | All |
| `HUBSPOT_PROPERTY_TYPE_ID` | `2-61770114` | All |
| `SESSION_SECRET` | (your 64-char hex string) | All |

"All" means: Production + Preview + Development. Vercel may default to "All"
already; if it has separate toggles, check all three.

Double-check the token doesn't have leading/trailing whitespace. Vercel
preserves whitespace in env var values.

---

## Step 6: Deploy

Click "Deploy".

The first build takes 2-4 minutes. Vercel will:
1. Clone your repo
2. Run `npm install`
3. Run `npm run build`
4. Deploy the output

If the build fails, the error log will show what went wrong. Common first-deploy
issues are listed in the Troubleshooting section below.

---

## Step 7: Verify the deployment

Once Vercel says "Deployment Ready", you'll get a URL like
`https://resihome-inspection-app-yourname.vercel.app`.

Click it. You should be redirected to `/login`.

Test the full flow:

1. **Sign in** with your HubSpot email
2. **Start a small test inspection** (try the Vacancy/Occupancy template
   first — it's the smallest, fewest sections; reduces test surface)
3. **Take a photo** with your phone camera (the form is mobile-friendly)
4. **Submit** and verify it appears in HubSpot sandbox

If everything works, share the URL with your team. If anything fails, the
Troubleshooting section below covers the most likely issues.

---

## Step 8: Set up custom domain (optional)

If you want a custom URL like `inspections.resihome.com` instead of the
vercel.app subdomain:

1. Vercel dashboard → your project → Settings → Domains
2. Add the domain you want
3. Vercel will give you a DNS record to add at your domain registrar
4. Once DNS propagates (usually within minutes), your custom domain works

---

## Going-forward workflow

Once set up, every time you `git push` to `main`, Vercel automatically
deploys. Your typical workflow becomes:

```powershell
# Make changes locally
# Test locally with `npm run dev`

git add .
git commit -m "Fix X"
git push
```

Wait 2-3 minutes; Vercel deploys automatically.

---

## Troubleshooting

### Build fails on Vercel with "Module not found" or similar

Check the build log for the exact error. Usually a missing dependency that
works locally because of cached `node_modules`. Fix: ensure `package.json`
lists every dependency, then `git commit && git push`.

### App loads but `/api/auth/login` returns 500

Most likely a missing env var. Vercel dashboard → project → Settings →
Environment Variables → verify all six are set. If you add/change vars,
you need to redeploy (Deployments tab → click "..." on latest → Redeploy).

### Login works but `/api/properties` returns 401 every time

The session cookie is being rejected. Usually a `SESSION_SECRET` issue —
either it's not set, or it's shorter than 32 chars. Verify in Vercel env
vars.

### Submit succeeds but PDF fails with sharp error

Known Vercel quirk. Fix:

```powershell
npm install --include=optional sharp
git add package.json package-lock.json
git commit -m "Force sharp optional dependencies"
git push
```

Vercel redeploys automatically.

### "FUNCTION_INVOCATION_TIMEOUT" on submit of large Scope inspections

Hobby tier's 10-second limit. Two paths:

- Quick fix: upgrade to Vercel Pro ($20/mo)
- Workaround: have inspectors submit smaller inspections (Turn instead of
  Scope) until we refactor for background processing

If this happens repeatedly, let me know and we'll discuss the background-job
refactor.

### Mobile photo upload is very slow

Expected if the photo is large (10MB+ from phone camera). The app
client-side compresses to ~1MB before upload, but the compression itself
takes 2-5 seconds on older phones. This is mostly normal.

### "Email not recognized" but the user IS in HubSpot

- Verify `settings.users.read` scope is on the Private App
- Verify the user is ACTIVE (not deactivated) in HubSpot
- Try a different user's email to isolate

---

## Important: post-deploy hygiene

After your first successful deploy:

1. **Document the production URL** somewhere your team can find (Slack pin,
   shared note, etc.)
2. **Check the Vercel dashboard** weekly for the first month — look at the
   "Functions" tab for errors or slow function invocations
3. **Don't add anything sensitive to the repo** — passwords, tokens,
   customer data. The repo is for code only; secrets stay in Vercel.
4. **Rotate `SESSION_SECRET` if any laptop with the value is lost or
   compromised** — this signs out everyone but it's safer

---

## What I (Claude) can help with after deploy

If anything breaks:

1. Share the **exact error message** (from browser console, Vercel function
   logs, or the screen)
2. Share what you were trying to do
3. I'll help diagnose and fix

I can't access Vercel logs directly, so the more detail you share, the
faster the fix.
