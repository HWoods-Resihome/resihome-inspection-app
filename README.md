# ResiHome Inspection App (v0.10 -- Round B)

Next.js field-inspection app branded to ResiHome.

## ⚠️ Working in this repo — multi-session git workflow (READ FIRST)

Multiple people **and multiple Claude Code sessions** may be editing this repo at
the same time, all shipping to `main`. To make concurrent work **stack** instead
of collide, do this every time:

1. **Pull the latest BEFORE making any edits:**
   `git fetch origin main && git rebase origin/main`
   (or `git pull --rebase origin main`). This bases your work on everyone else's
   latest so you're never editing a stale copy.
2. **Fetch + rebase again right BEFORE every push, then push:**
   `git fetch origin main && git rebase origin/main && git push origin main`.
   If the push is rejected (someone pushed while you worked), rebase and retry.
3. **Never force-push `main`.** A normal push can't erase anyone's commits — git
   rejects a non-fast-forward push, so you must integrate first. A `--force` is
   the only thing that *can* overwrite others' work, so it's forbidden here.
4. **On a conflict, keep BOTH sides** (resolve, don't discard), then continue the
   rebase.

Result: changes to *different* files/lines merge automatically and both survive;
only edits to the *same lines* need a quick manual merge. Nothing is silently
overwritten.

## What's new in v0.10 (Round B)

This is the big one. Round B introduces inspection lifecycle and auto-save.

### Lifecycle changes

- Inspections now flow through: **Scheduled -> In Progress -> Completed**
  (with **Cancelled** as a separate terminal state)
- Tapping "+ New Inspection" creates a **Scheduled** Inspection record in
  HubSpot immediately, then takes you to the form
- The first user edit on a Scheduled inspection automatically flips its
  status to **In Progress**
- Submitting sets status to **Completed**
- A "Cancel Inspection" button (red border) sets status to **Cancelled**

### Auto-save

- Every Q&A answer change is debounced for 2 seconds, then saved to HubSpot
- Every section photo change is debounced for 2.5 seconds, then saved
- Each new edit since the last save extends the debounce window
- The top of the form shows a global save indicator:
  - **All changes saved** (green check) -- idle
  - **Saving in a moment...** (amber) -- typing, debounce window active
  - **Saving...** (pink, spinning) -- save in flight
  - **Saved** (green) -- save just succeeded
  - **Save failed -- will retry** (red) -- network/server error, retries on next tick

### Tappable inspection list

- Every card on the homepage is now tappable. It opens `/inspection/[id]`
- For Scheduled or In Progress inspections, you can resume editing
- For Completed inspections, the form opens in **read-only mode** with a
  **"Reopen for editing"** button at the top (turns status back to In Progress)
- For Cancelled inspections, the form opens read-only without a reopen
  button

### Two routes for the form

- `/inspection/new` -- setup screen (template/property/bed/bath). After
  clicking "Begin Inspection," creates a Scheduled record and redirects to
  `/inspection/[id]`
- `/inspection/[id]` -- the form itself, which loads any existing answers
  from HubSpot and supports auto-save

## What's NOT in Round B (deferred to Round C)

- Custom in-app camera. Photos still use the file input which means iOS
  users have to tap "Choose File" -> "Photo Library" or "Take Photo or Video"
- No scheduling-only mode for managers (everyone goes through the same flow)

## HubSpot integration details

### New endpoints

- `POST /api/inspections/create` -- creates a Scheduled inspection
- `GET /api/inspections/[id]` -- fetches inspection + all associated answers
- `PATCH /api/inspections/[id]` -- update inspection properties (status, etc.)
- `POST /api/inspections/[id]/answers` -- upsert answer records (autosave)
- `POST /api/inspections/[id]/cancel` -- set status=Cancelled
- `POST /api/inspections/[id]/reopen` -- set status=In Progress (from Completed)
- `POST /api/inspections/[id]/submit` -- set status=Completed + summary fields

### How answer IDs work

Each Answer record has a deterministic `answer_id_external`:

```
{inspectionExternalId}_{questionIdExternal}__{instanceKey}
```

For example: `INSP-2026-05-27-abc12345_yard_drywall__bedroom-1`

This means a given Question + room instance always maps to the same external
ID, so re-saving updates the existing record instead of creating duplicates.

### Race conditions

- Single inspector editing on one device: clean (debounced saves)
- Same inspector with two browser tabs open: last-write-wins (no conflict
  detection in Round B). Avoid this for now.
- Two inspectors editing the same inspection: last-write-wins. Same advice.

## Prerequisites (mostly unchanged)

1. Node.js 20 LTS
2. HubSpot Private App scopes (same as v0.9)
3. The Inspection object's `status` property must have dropdown values:
   `Scheduled`, `In Progress`, `Completed`, `Cancelled`
4. The Inspection Answer object must have these properties (added throughout
   previous rounds):
   - `answer_id_external` (text, unique)
   - `question_id_external` (text)
   - `answer_type` (dropdown: qa, section_photo, signature, photo_only, line_item)
   - `section`, `location`, `answer_value`, `note`, `quantity`, `assigned_to`
   - `photo_urls`, `photo_count`
   - `inspection_id_external` (text)

If any of these properties are missing in your sandbox, autosave will fail
with a 400 error from HubSpot.

## Setup -- if upgrading from v0.9

```powershell
cd C:\Users\hwoods\Documents\inspection_app
# Replace files with v0.10 drop
npm install   # no new deps
npm run dev
```

## Testing checklist for Round B

### Smoke test (5 min)

1. Sign in. Homepage shows existing inspections from sandbox.
2. Tap "+ New Inspection". Fill setup screen. Tap "Begin Inspection."
3. Watch the URL: it should briefly show `/inspection/new`, then
   redirect to `/inspection/[someId]`.
4. The form opens with the global save indicator showing "All changes saved"
   (because nothing has been edited yet).
5. Tap any picklist option. The indicator should flip to "Saving in a
   moment..." then "Saving..." then "Saved" within 3 seconds.
6. Go back to the inspections list (tap "Exit" at the bottom). The new
   inspection should appear with status **In Progress** (amber badge).
7. Tap the card. The form re-opens. Your previous edit should be preserved
   (the picklist button highlighted, etc.).
8. Finish a few more answers. Tap "Submit Inspection."
9. Confirm the submit dialog. Wait for success page.
10. Back to homepage. The inspection now shows **Completed** (green badge).

### Resumable progress test (10 min)

1. Start a new inspection. Answer 5-10 questions across multiple sections.
2. Add one photo (per-question or section).
3. Wait for "Saved" indicator (3 seconds after the last edit).
4. Close the browser tab entirely.
5. Open a new tab. Sign in again. Open the same inspection from the list.
6. All your answers and the photo should be there.
7. Continue editing, then submit normally.

### Cancel test

1. Start a new inspection. Don't submit it.
2. Tap "Cancel Inspection" (red bordered button at bottom).
3. Confirm. You're redirected to the list.
4. The inspection appears with **Cancelled** (gray strikethrough) badge.
5. Tap it. The form opens in read-only mode with the "Cancelled" notice
   at the top.

### Reopen test

1. From the list, tap any **Completed** inspection.
2. Form opens with "Read-only (Completed)" indicator and the amber banner
   at the top.
3. Tap "Reopen for editing".
4. Confirm. Page reloads.
5. Form is now editable, status back to **In Progress**.

### Two-bedroom resume test (tricky one)

1. Start a new Scope inspection with 2 bedrooms.
2. Answer Bedroom 1 picklist questions only. Wait for save.
3. Close the tab, reopen via the list.
4. Bedroom 1 answers should still be there.
5. Bedroom 2 should still be untouched (collapsed by default per existing
   collapse rules).

## Known limitations

- **Race condition on first-paint autosave hydration**: if you edit an
  answer in the first ~50ms after the page loads, the autosave hook might
  not yet know which existing answer records to update. In practice this is
  effectively impossible to hit, but if you see duplicate Answer records
  in HubSpot for the same question, this is the likely cause.
- **No undo**: once an answer is saved to HubSpot, the only way to revert
  is to overwrite it with a different value (or delete the record from
  the HubSpot UI).
- **Section photo deletes don't archive cleanly**: if you remove all
  photos from a section, the section_photo Answer record will be archived
  on the next save cycle (~2.5 seconds). If you remove and re-add quickly,
  there may be a brief duplicate.
- **PDF generation** still works on Completed inspections via the existing
  /api/pdf endpoint. The "Reopen" flow doesn't auto-regenerate the PDF;
  re-submit to generate a fresh one.

## File changes since v0.9

NEW:
- `pages/api/inspections/create.ts`
- `pages/api/inspections/[id]/index.ts`
- `pages/api/inspections/[id]/answers.ts`
- `pages/api/inspections/[id]/cancel.ts`
- `pages/api/inspections/[id]/reopen.ts`
- `pages/api/inspections/[id]/submit.ts`
- `pages/inspection/[id].tsx`
- `lib/useAutosave.ts`

MODIFIED:
- `lib/hubspot.ts` -- added fetchInspectionById, fetchInspectionWithPropertyRef,
  fetchAnswersForInspection, updateInspection, createScheduledInspection,
  upsertAnswers, archiveAnswers
- `lib/types.ts` -- (no changes, AnswerInput already supports the relevant fields)
- `pages/index.tsx` -- "+ New Inspection" tile color fixed (lighter pink)
- `pages/inspection/new.tsx` -- handleBegin now creates a Scheduled record and
  redirects to /inspection/[id]
- `components/InspectionCard.tsx` -- wrapped in a Next.js Link to make tappable
- `components/QuestionForm.tsx` -- substantial: hydrate from existingAnswers,
  wire updateAnswer to autosave, section photo sync, readOnly mode, save
  indicator UI, Cancel Inspection button

## Next: Round C

- Custom in-app camera replacing the file input
- Multi-shot capture without leaving the app
