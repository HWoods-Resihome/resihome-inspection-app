# ResiHome Inspection App (v0.8)

Next.js field-inspection app branded to ResiHome.

## What's new in v0.8

- **`score` field renamed to `quantity` across the app**, matching the new
  `quantity` field on the HubSpot Inspection Answer object. The label in
  the UI now reads "Quantity"; the PDF triggered box shows "Quantity: N".
  Still Scope-only (hidden on non-Scope templates; auto-set to 1 server-side
  for non-Scope triggered answers).
- **Field order in the action panel rearranged**:
  1. Note
  2. Assigned to  (moved up)
  3. Quantity     (renamed from Score, moved down)
  4. Photos
- **Assigned To options cleanup**:
  - "None" is now filtered out (case-insensitive) wherever it appears in
    the HubSpot `assigned_to_options` data
  - "Vendor 1" is forced to the first position when present
- **`total_score` rollup removed** from the Inspection record. There is no
  `total_quantity` replacement -- if you want one, create the field in
  HubSpot and we can add the rollup back.

## Important: data migration not included

Existing Inspection Answer records in HubSpot that have `score` populated
will NOT be auto-migrated to `quantity`. Going forward, new submissions
write to `quantity` only. The old `score` field on existing records remains
untouched.

If you want a one-time migration script to copy `score` -> `quantity` on
existing records, that's a separate ask -- let me know.

## Prerequisites (unchanged)

1. Node.js 20 LTS
2. HubSpot Private App scopes:
   - `crm.schemas.custom.read/write`, `crm.objects.custom.read/write`,
     `crm.associations.read/write`
   - `files.read`, `files.write`
   - `settings.users.read`
3. **NEW**: a `quantity` property must exist on the Inspection Answer object
   in HubSpot (you confirmed you already created this)

## Setup -- if upgrading from v0.7

```powershell
cd C:\Users\hwoods\Documents\inspection_app
# Replace files with v0.8 drop, then:
npm install   # no new deps
npm run dev
```

## File changes since v0.7

MODIFIED:
- `lib/types.ts`: AnswerInput.score -> AnswerInput.quantity
- `lib/pdf.tsx`: PdfAnswer.score -> PdfAnswer.quantity; reordered Assigned
  To above Quantity in the triggered box
- `pages/api/submit.ts`: writes `props.quantity` instead of `props.score`;
  removed the `total_score` rollup calculation
- `pages/api/pdf.ts`: passes through `quantity` to the PDF
- `components/QuestionItem.tsx`: input label is now "Quantity"; UI panel
  renders Assigned To above Quantity; added "None" filter + "Vendor 1"
  forced-first logic for the Assigned To options
- `components/QuestionForm.tsx`: init quantity=null; validates quantity on
  Scope triggered answers; non-Scope backstop now defaults quantity=1

## What stayed the same

- HubSpot date-based 2026-03 association migration from v0.7
- Scope-only "first section open, rest collapsed" from v0.7
- Email-based auth from v0.5
- All other field behavior

## Behavior notes (v0.8)

**Assigned To options cleanup**: the rendered list is now:
1. Take `question.assignedToOptions` (or hardcoded fallback if empty)
2. Filter out any value where `trim().toLowerCase() === 'none'`
3. If "Vendor 1" exists at any position, move it to position 0

This is purely client-side defensive cleanup. You can ALSO clean up the
HubSpot data so the source is correct, but the UI handles drift either way.

**Hardcoded fallback**: if `question.assignedToOptions` is empty for any
question, the UI falls back to:
`['Vendor 1', 'Vendor 2', 'Internal Resolution']`

To change this list, edit `QuestionItem.tsx` line ~180 (the `rawOptions`
const).

**Quantity validation**: same as old Score:
- On Scope: triggered answers must have a quantity (defaulted to 1, can
  override). Validation blocks submit if missing.
- On non-Scope: quantity field is hidden; backstop sets quantity=1 server-side
  for triggered answers so the data is consistent.

## Troubleshooting

**Quantity not saving to HubSpot**: verify the property API name on the
Inspection Answer object is exactly `quantity` (lowercase). HubSpot UI:
Settings -> Properties -> Inspection Answer -> Quantity -> the "API name"
field in the property's edit dialog. If it's something else (`qa_quantity`,
`answer_quantity`, etc.), edit line ~89 of `pages/api/submit.ts`:

```ts
if (a.quantity != null) props.quantity = a.quantity;
```

to use the actual property name on the right side.

**"None" still appears in Assigned To**: hard refresh (Ctrl+Shift+R) to
bust browser cache. If still showing, check the data source: look at the
question record's `assigned_to_options` field in HubSpot; the pipe-separated
value might have a non-standard variant like "NONE" or "(none)" that escapes
the case-insensitive `.trim().toLowerCase() === 'none'` check. We can
loosen the filter if needed.

**"Vendor 1" not first**: check `question.assignedToOptions` in HubSpot.
The filter promotes "Vendor 1" only if it's present in the list. If the
question's data has "Vendor1" (no space) or "vendor 1" (lowercase) the
match fails because the check is `trim().toLowerCase() === 'vendor 1'`.
