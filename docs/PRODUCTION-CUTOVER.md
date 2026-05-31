# ResiWalk — Sandbox → Production Cutover Runbook

Target production portal: **22536354**. Commands shown for **Windows PowerShell**.
The app deploys on **Vercel** (push-to-deploy); production env vars live in Vercel.

> **Golden rule:** the HubSpot token is set as an environment variable, never typed
> into a command or pasted anywhere shared. We point the **same** `HUBSPOT_TOKEN`
> at the sandbox to *export*, then at production to *import*.

The migration **clones the live sandbox schema into production**, so production
gets every custom object and **every field** (base + all added over the project)
with no manual field entry.

---

## 0. Prerequisites (one time)

- **Python 3** installed (`python --version`).
- One pip dependency for the data load:
  ```powershell
  pip install pandas openpyxl
  ```
- **Production private app "ResiWlk"** created with a token. Give it the **same
  scopes as the sandbox app**, and make sure these are included:
  - `crm.schemas.custom.read`, `crm.schemas.custom.write`  ← create objects/props
  - `crm.objects.custom.read`, `crm.objects.custom.write`   ← read/write records
  - `files`                                                  ← PDF uploads
  - `account-info.security.read` (or oauth) ← lets the safety "which portal am I on?" check work
- Clone of this repo locally (you already deploy from it).

---

## 1. Export the schema + questions from SANDBOX (read-only — safe)

```powershell
$env:HUBSPOT_TOKEN = "<SANDBOX token>"
cd scripts\prod_migration
python clone_to_prod.py export
```

It exports **only the inspection app's own objects** (it ignores your other
portal objects like hoas/listing/agents/properties), and writes:
- `scripts/prod_migration/export/schemas.json` — the 5 app objects
  (`inspection`, `inspection_question`, `inspection_answer`, `rate_card_line_item`,
  `region_rate`) with their custom properties and the associations *between them*,
  plus a `ref_object` block listing the app's required fields on your existing
  **Property** object (which is referenced, not recreated).
- `scripts/prod_migration/export/questions.json` — all inspection_question records.

**Review `schemas.json`** — confirm the 5 objects are present with their property
lists (e.g. `last_tenant_time_in_home_months` under the Property ref_object,
`finalize_in_progress` + `*_snapshot` + `pdf_*` + `section_list_json` + `qc_*`
under inspection/inspection_answer).

---

## 2. Dry-run the import into PRODUCTION (no writes)

```powershell
$env:HUBSPOT_TOKEN = "<PRODUCTION token>"
python clone_to_prod.py import --portal 22536354
```

- The script first confirms the token is connected to portal **22536354** and
  **aborts** if not (so you can't write to the wrong account).
- It prints exactly what it *would* create. Read it. Nothing is written.

## 3. Real import (creates objects + properties + associations)

```powershell
python clone_to_prod.py import --portal 22536354 --live
```

At the end it prints **"Production objectTypeIds"** — e.g.:
```
  inspection: 2-77770001
  inspection_question: 2-77770002
  inspection_answer: 2-77770003
  property: 2-77770004
  rate_card_line_item: 2-77770005
  region_rate: 2-77770006
```
**Copy these** — they go into Vercel in step 6. (It's idempotent: safe to re-run;
existing objects are skipped and only missing properties are added.)

---

## 4. Load the catalog + region data into PRODUCTION

Still pointed at the production token:
```powershell
cd ..\rate_card_phase1
python phase1_step5_load_data.py
```
Loads the ~853 catalog rows (`line_items.xlsx`) and the region-rate records
(`region_matrix.xlsx`). Verify counts in the HubSpot UI afterward.

---

## 5. Migrate the QUESTION records into PRODUCTION

```powershell
cd ..\prod_migration
python clone_to_prod.py import-questions --portal 22536354          # dry-run
python clone_to_prod.py import-questions --portal 22536354 --live   # apply
```
(De-dupes by `question_id_external`, so re-runs won't duplicate.)

---

## 6. Set the Vercel production environment variables

In Vercel → Project → Settings → Environment Variables (Production scope), set
everything from `.env.production.example`, including the objectTypeIds from
step 3:
- `HUBSPOT_TOKEN` (production), `HUBSPOT_PORTAL_ID=22536354`
- `HUBSPOT_INSPECTION_TYPE_ID`, `HUBSPOT_INSPECTION_QUESTION_TYPE_ID`,
  `HUBSPOT_INSPECTION_ANSWER_TYPE_ID`, `HUBSPOT_PROPERTY_TYPE_ID`
- `HUBSPOT_RATE_CARD_LINE_ITEM_TYPE_ID`, `HUBSPOT_REGION_RATE_TYPE_ID`
- `SESSION_SECRET` (new random value), `ANTHROPIC_API_KEY`
- Optional: `VOYAGE_API_KEY`, `OPENAI_API_KEY`, Gmail vars (redirect → prod
  domain), `FINALIZE_LOCK_PROPERTY=finalize_in_progress`, `ERROR_WEBHOOK_URL`

Then **redeploy** (push any commit, or "Redeploy" in Vercel) so the new env is
picked up.

---

## 7. Smoke test in production

- [ ] Sign in.
- [ ] New **Scope Rate Card** → add lines by typing AND by voice → photos →
      **AI Review** (run, apply, confirm edits persist) → **Submit for Approval**.
- [ ] As approver: open Pending Approval → **Finalize** → PDFs generate (xlsx
      last) → completion email sends → links point to **app.hubspot.com/contacts/22536354/...**.
- [ ] Concurrent **finalize** from two tabs → second is blocked (finalize lock).
- [ ] **QC Turn Re-Inspect** → pick the source Scope card → lines copy → Pass/Fail.
- [ ] Offline: queue an edit, reconnect, confirm the sync banner clears.

---

## Rollback / safety notes

- The production portal is greenfield (no live data yet), so if an object looks
  wrong you can delete it in HubSpot and re-run the import.
- `export` is read-only; `import`/`import-questions` are dry-run unless `--live`
  and refuse to run unless `--portal 22536354` matches the connected token.
- If `clone_to_prod.py import` errors on a specific property/association, it
  prints the HubSpot reason; fix that property in `schemas.json` (or the source)
  and re-run — completed objects are skipped.
