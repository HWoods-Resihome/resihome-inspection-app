# Remove Sections Script

Permanently archives Inspection Question records in 6 sections that are being removed from the app:

- Foundation
- Roof / Gutters
- Office
- Attic
- Utilities
- Crawlspace

## Why archive (not delete)

HubSpot's app-side fetch excludes archived records, so they disappear from the form immediately. But the records still exist in HubSpot, which means:

- Historical inspections that reference them still display correctly
- If you change your mind, you can un-archive individual records in HubSpot UI
- No data is destroyed

## Usage

```powershell
cd C:\Users\hwoods\Documents\inspection_app\scripts\remove_sections

# Dry run first (no changes made) — shows what would be archived
python remove_sections.py

# Once you've reviewed the dry run, run for real:
python remove_sections.py --confirm
```

The script reads `HUBSPOT_SANDBOX_TOKEN` from your `.env.local` (same as the Phase 1 scripts).

## What to look for in the dry-run output

- "Matched X questions" — confirms questions were found in those sections
- "WARNING: no questions found" — means the section name in HubSpot didn't match. You may need to adjust the matching logic if HubSpot has a typo or different spelling.
- The "Preview" section shows the first 10 questions that would be archived — confirm these look correct before running with --confirm

## To restore an archived question

1. Open HubSpot
2. Settings → Objects → Inspection Questions
3. Filter view: Archived
4. Find the question, click Actions → Restore
