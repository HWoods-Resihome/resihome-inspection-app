# Photo Backfill Runbook — HubSpot File Manager → Vercel Blob

Standalone one-off migration (`scripts/migratePhotosToBlob.mjs`). Copies photos
still hosted in HubSpot Files into Vercel Blob, rewrites the reference on each
`inspection_answer` record (`photo_urls` / `after_photo_urls`), verifies the copy
byte-for-byte, and — only when you explicitly ask — deletes the HubSpot original.

Part 1 (new captures already go to Blob) shipped separately, so this backfill is
aimed at a set that no longer grows.

## Prerequisites (environment — nothing is hardcoded)

Set these before running. Values live in the migration brief; the script reads
them from the environment and hardcodes no tokens/portals.

```
export HUBSPOT_TOKEN=<the Resihome_PM private-app token (Files + CRM scopes)>
export HUBSPOT_INSPECTION_TYPE_ID=<inspection object type id>
export HUBSPOT_INSPECTION_ANSWER_TYPE_ID=<inspection_answer object type id>
export BLOB_READ_WRITE_TOKEN=<Vercel Blob store RW token>   # only needed for --apply
```

Use the SAME Vercel Blob store the app uses (so migrated photos live alongside
new captures). Node 18+ (global fetch).

## The three deliberate passes

Run them in order. Each is a separate decision.

### 1. Dry run (writes nothing, deletes nothing)
Inventory what would move — counts, total bytes, per-URL log, errors.
```
node scripts/migratePhotosToBlob.mjs --inspection <id>      # one inspection first
node scripts/migratePhotosToBlob.mjs                        # or the whole set
```

### 2. Copy + verify (writes Blob + rewrites references; NO deletes)
Copies to Blob, verifies byte match, updates the answer references. HubSpot
originals are left untouched so you can confirm the app still shows every photo.
```
node scripts/migratePhotosToBlob.mjs --inspection <id> --apply
```
After this, open that inspection in the app — every photo should still display
(now served from Blob). Confirm before deleting anything.

### 3. Gated deletion (removes the HubSpot originals)
Only after a verified copy pass. Deletes each migrated file from HubSpot, and
only for files whose Blob copy verified and whose reference write succeeded.
```
node scripts/migratePhotosToBlob.mjs --inspection <id> --apply --delete
```

## Recommended first-run (small test, as agreed)

Pick one inspection with photos and walk the full cycle on just it:
```
node scripts/migratePhotosToBlob.mjs --inspection 58644587646              # dry run
node scripts/migratePhotosToBlob.mjs --inspection 58644587646 --apply      # copy+verify
#  → open that inspection in the app; confirm photos render from Blob
node scripts/migratePhotosToBlob.mjs --inspection 58644587646 --apply --delete   # reclaim
```
Then repeat without `--inspection` for the full portfolio once you trust it.

## Flags
- `--inspection <id>`  only that inspection's answers (via v4 associations).
- `--apply`            copy to Blob + rewrite references. Omit = dry run.
- `--delete`           also delete the HubSpot original (requires `--apply`).
- `--limit <n>`        cap answers processed (extra safety while testing).
- `--state <path>`     resume state file (default `.migrate-photos-state.json`).
- `--report-orphans`   list HubSpot files in the folder that NO answer references.

## Safety / behavior
- **Dry-run by default.** `--apply` is required to write; `--delete` is separate
  and off by default.
- **Strict per-URL order:** download → upload → verify byte count → write
  reference → (gated) delete. Nothing is deleted until its Blob copy is verified
  AND the reference write returned success.
- **Idempotent + resumable:** a state file records done answers + a
  old-URL→new-URL map. Re-running skips completed answers and never re-copies a
  URL. Safe to interrupt (Ctrl-C) and re-run.
- **Reference-driven:** it migrates the URLs the app actually displays
  (`photo_urls`/`after_photo_urls` on `inspection_answer`), replacing each URL in
  place so delimiters are preserved. Files no answer references are orphans —
  never touched; list them with `--report-orphans`.
- **Structured log:** every URL outcome is written to
  `migrate-photos-<timestamp>.log.jsonl` (copied / verified / referenced /
  deleted / error / orphan). The error + orphan lines are the whole point of the
  run being trustworthy — review them.
- **Rate-limit aware:** 429/5xx get exponential backoff; the search path paces
  itself between pages.

## Rollback
Until `--delete` runs, the HubSpot originals still exist. If a copy pass looks
wrong, the references can be pointed back at the HubSpot URLs from the JSONL log
(each line has `oldUrl` + `newUrl`). Do NOT run `--delete` until a copy pass is
verified in the app.
