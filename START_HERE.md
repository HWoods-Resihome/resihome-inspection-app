# START HERE — Fresh Setup Guide

This walks you through getting the app running cleanly, both locally and on
Vercel.

Estimated time: 15-20 minutes if you have all your values handy.

---

## Deploying updates from Claude (the easy way)

Once you have the repo cloned with git (see initial setup below), updating
the code is one command. From inside your cloned repo folder:

```powershell
.\refresh.ps1 "v0.19.18 - save status in header"
```

That script will:
- Find the newest `inspection_app*.zip` in your Downloads folder
- Wipe the repo (keeping `.git` and the deploy scripts)
- Extract the zip on top
- Validate `package.json` and `vercel.json`, strip any UTF-8 BOM that may have
  snuck in from Notepad or browser uploads
- Show you what changed
- Commit + push to GitHub (Vercel auto-deploys on push)

If you've already extracted the zip manually and just want to commit + push:

```powershell
.\deploy.ps1 "your commit message"
```

**Stop using the GitHub web drag-and-drop upload.** It re-encodes JSON files,
silently truncates folders, and corrupts hidden files. Use git on the command
line via the scripts above.

---

## What you'll need before starting

Gather these values in advance — easiest to put them in a Notepad scratch file
so they're ready to paste:

| Value | Where to get it |
|---|---|
| HubSpot Private App token | https://app.hubspot.com/private-apps/51415639 → your app → Auth tab → "Show token" |
| SESSION_SECRET | Generate a new one (see below) |

To generate a new SESSION_SECRET, run this in PowerShell:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the 64-character hex string it prints.

---

## Step 1: Verify your HubSpot Private App scopes

Before anything else, make sure the Private App has all the right
permissions. Go to:

https://app.hubspot.com/private-apps/51415639

Click your app → **Auth tab** → scroll down to "Scopes" → these MUST be checked:

- `crm.schemas.custom.read`
- `crm.schemas.custom.write`
- `crm.objects.custom.read`
- `crm.objects.custom.write`
- `crm.associations.read`
- `crm.associations.write`
- `files.read`
- `files.write`
- `settings.users.read`   ← critical for login

If any are missing, add them and click "Commit changes" at the top. The
token will still work but with the new scopes.

If you've recently been changing things, you can also **rotate the token**
here — generates a new `pat-na1-...` value. The old one stops working
immediately. Copy the new one.

---

## Step 2: Set up your local folder fresh

In Windows File Explorer:

1. Open `C:\Users\hwoods\Documents`
2. Right-click the `inspection_app` folder → Rename → call it
   `inspection_app_OLD_backup` (this preserves your old work in case)
3. Unzip the v0.8.1 zip I sent
4. Move the unzipped `inspection_app` folder into
   `C:\Users\hwoods\Documents\`
5. Confirm you now have `C:\Users\hwoods\Documents\inspection_app` with
   fresh files

---

## Step 3: Create your .env.local file

In the new `inspection_app` folder, you'll see a file called
`_FILL_IN_YOUR_VALUES_.env.local.txt`. This is the template I've prepared.

Open it in Notepad. Replace the two placeholder values:

```
HUBSPOT_SANDBOX_TOKEN=<PASTE_YOUR_PAT_TOKEN_HERE>
SESSION_SECRET=<PASTE_YOUR_64_CHAR_HEX_STRING_HERE>
```

After replacing those two values, the file should look something like:

```
HUBSPOT_SANDBOX_TOKEN=pat-na1-abc123-actual-token-value-here
HUBSPOT_INSPECTION_TYPE_ID=2-63142762
HUBSPOT_INSPECTION_QUESTION_TYPE_ID=2-63142763
HUBSPOT_INSPECTION_ANSWER_TYPE_ID=2-63142766
HUBSPOT_PROPERTY_TYPE_ID=2-61770114
SESSION_SECRET=a1b2c3d4e5f6...
```

**Critical save instructions for Notepad:**

1. File → Save As
2. Navigate to `C:\Users\hwoods\Documents\inspection_app`
3. **"Save as type"** dropdown → change to **"All Files (*.*)"**
4. File name: type exactly `.env.local` (with the leading dot, no .txt)
5. **"Encoding"** dropdown → make sure it's **"UTF-8"** (not "UTF-8 with BOM")
6. Click Save

Then **delete the `_FILL_IN_YOUR_VALUES_.env.local.txt` template** —
you don't want it lying around or accidentally pushed to GitHub.

---

## Step 4: Verify .env.local is correct

In PowerShell:

```powershell
cd C:\Users\hwoods\Documents\inspection_app
Get-ChildItem .env*
```

You should see EXACTLY two files:
- `.env.local`             (your real file with secret values)
- `.env.local.example`     (the template with placeholders)

If you see `.env.local.txt`, Notepad tricked you. Rename it:

```powershell
Rename-Item .env.local.txt .env.local
```

If `.env.local` is missing entirely, Notepad saved it somewhere else. Search
your computer for `.env.local` or repeat Step 3.

Verify the contents are intact:

```powershell
Get-Content .env.local
```

You should see 6 lines with real values, no placeholders.

---

## Step 5: Run locally to confirm it works

```powershell
npm install
npm run dev
```

Wait for "ready in X.Xs", then open http://localhost:3000 in your browser.

You should see the login page. Sign in with your HubSpot email.

If signin succeeds → local is working. Continue to Step 6.

If you get "Could not verify users at this time":
- Check the PowerShell terminal for the underlying error
- Most likely cause: token typo or missing scope. Re-do Steps 1-3.

---

## Step 6: Set up the GitHub repo (drag-and-drop method)

If you already have a working GitHub repo from before
(`HWoods-Resihome/resihome-inspection-app`), you have two options:

### Option A: Use the existing repo (faster)

1. Go to https://github.com/HWoods-Resihome/resihome-inspection-app
2. Click the file list area
3. For each existing file, click it → click the trash icon (top right) →
   "Commit changes" → repeat for all files. OR easier: delete the whole
   repo and recreate it (next option).

### Option B: Delete and recreate the repo (cleaner)

1. Go to https://github.com/HWoods-Resihome/resihome-inspection-app/settings
2. Scroll to the bottom → "Delete this repository" → confirm
3. Go to https://github.com/new
4. Repository name: `resihome-inspection-app`
5. Visibility: **Private**
6. Do NOT initialize with README/gitignore/license
7. Click "Create repository"
8. On the next page, you'll see a quick-setup view. Click the
   **"uploading an existing file"** link in the middle of the page.

### Drag-and-drop the files

You're now at https://github.com/HWoods-Resihome/resihome-inspection-app/upload/main

In your File Explorer, open `C:\Users\hwoods\Documents\inspection_app`.

**Critical: do NOT include these in the upload:**
- `.env.local` (real secrets — would be a security incident)
- `node_modules` folder (huge, slow, GitHub won't accept anyway)
- `.next` folder (build output, not needed)
- `_FILL_IN_YOUR_VALUES_.env.local.txt` (should've been deleted in Step 3)

**Safe approach:**

1. Select ALL files in the folder (Ctrl+A in Windows File Explorer)
2. **HOLD Ctrl** and click these specific items to deselect them:
   - The `node_modules` folder (if present)
   - The `.next` folder (if present)
   - The `.env.local` file (if visible — Windows hides dot-files by default,
     turn on "Show hidden items" in the View menu to see it)
3. With the safe subset selected, drag them onto the GitHub web page

Wait while files upload — there are about 35 files, should take a minute.

At the bottom of the page:
- Commit message: `Initial v0.8.1 upload`
- Click **"Commit changes"** button

Refresh the page — your files are now in the repo. **Verify `.env.local`
is NOT in the file list.** If it is, click into it → delete → commit.

---

## Step 7: Connect Vercel

1. Go to https://vercel.com/new
2. If you don't see your repo, click "Adjust GitHub App Permissions" and
   grant Vercel access to the `resihome-inspection-app` repo
3. Find `resihome-inspection-app` in the list → click **Import**

You'll see the project configuration screen.

### Configure environment variables

This is where you tell Vercel about all the secrets. Click "Environment
Variables" to expand the section, then add EACH of these by clicking
"Add Another":

| Name | Value | Apply to |
|---|---|---|
| HUBSPOT_SANDBOX_TOKEN | `pat-na1-...` (your real token) | All |
| HUBSPOT_INSPECTION_TYPE_ID | `2-63142762` | All |
| HUBSPOT_INSPECTION_QUESTION_TYPE_ID | `2-63142763` | All |
| HUBSPOT_INSPECTION_ANSWER_TYPE_ID | `2-63142766` | All |
| HUBSPOT_PROPERTY_TYPE_ID | `2-61770114` | All |
| SESSION_SECRET | (your 64-char hex string) | All |

Triple-check:
- No leading/trailing spaces in any value
- The token is the complete `pat-na1-...` string, all on one line
- "Apply to" is set to "All" (Production + Preview + Development) for each

### Deploy

Click **Deploy** at the bottom. First build takes 2-4 minutes.

When it completes, you'll get a URL like
`https://resihome-inspection-app-xxx.vercel.app`. Click it.

---

## Step 8: Test the live site

On your phone:

1. Open the Vercel URL
2. Sign in with your HubSpot email
3. Start a small test inspection (use Vacancy template — smallest)
4. Add a photo from your camera roll
5. Submit

If everything works → live deployment complete.

If anything fails → share the error message and what step you were on.

---

## Future updates workflow

Once this is set up, future updates from me work like this:

1. I send you new zip
2. You unzip and replace files in `C:\Users\hwoods\Documents\inspection_app`
   (your `.env.local` stays untouched because it's not in the zip)
3. Test locally with `npm run dev`
4. Go to GitHub repo → drag updated files in → commit
5. Vercel auto-deploys

Or if you want to learn `git push` later, it's faster than dragging
files. But drag-and-drop works fine.

---

## Things that could go wrong

**"Could not verify users at this time"** on login
→ token problem. See Step 4 to verify .env.local.

**Vercel build fails**
→ Check the build log on Vercel for the exact error. Most common: a
missing env var. Re-check Step 7.

**App loads but signin returns 500**
→ SESSION_SECRET is missing or too short. Vercel dashboard → project →
Settings → Environment Variables → check SESSION_SECRET is set and is
64 characters.

**Drag-and-drop to GitHub doesn't accept folders**
→ Some browsers don't handle nested folders well in drag-and-drop. Try
Chrome if you're using a different browser. As a fallback: drag the
contents of subfolders separately (you'll lose the folder structure;
not what we want). The cleaner fallback: install GitHub Desktop, which
gives you a visual Git client that handles folders correctly.
