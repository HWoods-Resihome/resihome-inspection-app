# ResiHome Inspection App (v0.9 — Round A)

Next.js field-inspection app branded to ResiHome.

## What's new in v0.9 (Round A)

This release is the first of three rounds to support inspection lifecycle
management. Round A delivers the LIST VIEW. Rounds B and C come next.

- **New homepage: inspection list view** -- replaces the previous "Start
  New Inspection" card. The list shows all inspections from HubSpot with
  status badges, search by address, and filter chips.
- **Status badges** with semantic colors:
  - Scheduled: gray
  - In Progress: amber
  - Completed: green
  - Cancelled: gray with line-through
- **Search by property address** (case-insensitive substring match)
- **Filter chips by status**: All / Scheduled / In Progress / Completed
  / Cancelled (Cancelled chip only appears if there are any)
- **Submit now writes Title-Case status**: `'Completed'` instead of
  `'completed'` to match the HubSpot dropdown value
- **+ New Inspection button** opens the existing setup flow as before

## What's NOT in Round A (deferred to Rounds B and C)

- **Tapping an inspection card does nothing yet** -- in Round A the cards
  are read-only display only. Round B adds the "open and resume" behavior.
- **No scheduling UI** -- managers can't create Scheduled inspections from
  the app yet. Today every new inspection still goes Scheduled-less, straight
  to Completed at submit. Round B adds scheduling.
- **No mid-inspection save/resume** -- inspectors still fill out the form
  in one sitting and submit at the end. Closing the browser still loses
  in-progress work. Round B fixes this.
- **No in-app camera** -- still using the file input. Round C adds the
  custom camera.

## How Round A behaves with existing inspection data

Inspections that already exist in HubSpot (from prior v0.8.x sandbox tests)
will appear in the list. Their status field shows whatever value HubSpot
has -- if it's blank, the badge shows "Unknown" in gray.

Newly submitted inspections (in v0.9 and later) will appear with status
"Completed" because that's what `/api/submit` writes.

If you have existing test inspections in HubSpot with status `'completed'`
(lowercase), the StatusBadge component normalizes this to "Completed" for
display. So you don't need to fix old records manually.

## What the list view shows on each card

- Property address (top-left, bold)
- Status badge (top-right)
- Date (most recent of: scheduled_date, completed_at, hs_createdate)
- Inspector name
- Pretty template name (e.g., "Scope" from "pm_scope_inspection")
- Total questions answered (only if data exists)

## Prerequisites (unchanged)

1. Node.js 20 LTS
2. HubSpot Private App scopes (same as v0.8.x)
3. **The Inspection object must have a `status` property** with these
   dropdown values: `Scheduled`, `In Progress`, `Completed`, `Cancelled`
   (you confirmed this exists)

## Setup -- if upgrading from v0.8.x

```powershell
cd C:\Users\hwoods\Documents\inspection_app
# Replace files with v0.9 drop, then:
npm install   # no new deps
npm run dev
```

## File changes since v0.8.1

NEW:
- `pages/api/inspections.ts` -- GET endpoint returning all inspections
- `components/StatusBadge.tsx` -- reusable status pill
- `components/InspectionCard.tsx` -- card UI for each inspection

MODIFIED:
- `lib/types.ts` -- added InspectionSummary type
- `lib/hubspot.ts` -- added fetchInspections() function
- `pages/index.tsx` -- completely rewritten as the inspection list view
- `pages/api/submit.ts` -- status now written as 'Completed' (title case)

UNCHANGED:
- The inspection form (`pages/inspection/new.tsx`, `components/QuestionForm.tsx`, etc.)
- Auth, middleware, login page
- PDF generation
- HubSpot API integration (still 2026-03 date-based associations)

## Testing checklist for Round A

After deployment:

1. Sign in -- new homepage should appear with the pink header and list
2. If you have existing inspections in HubSpot sandbox, they should
   appear in the list with appropriate status badges
3. Type something in the search box -- list should filter
4. Click filter chips -- list should switch by status
5. Click "+ New Inspection" -- should still go to the setup page and
   work exactly as before
6. Submit a new inspection -- should appear at the top of the list with
   status "Completed" (green badge)

If any inspection has status "Unknown" (gray), open the record in HubSpot
and check its status field value. You may need to set it to one of the
four dropdown values manually.

## Next: Round B (coming soon)

- Scheduling UI: managers can create Scheduled inspections
- Tapping a Scheduled/In Progress card opens it and loads existing answers
- Auto-save answers as inspector edits
- Status transitions automatically: Scheduled -> In Progress on first edit,
  In Progress -> Completed on submit

This is the largest of the three rounds. Plan on 2-3 days of work.

## Next next: Round C (after B)

- Custom in-app camera replacing the file input
- Multi-shot capture without leaving the app
- Per-photo review/retake
