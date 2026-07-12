// Shared form styling tokens so Inspections and Services render fields, cards,
// and primary actions identically. Title-case black labels + white bordered
// inputs are the app standard (see the New Inspection / New Service screens).

/** Field label — Title Case, black, above the control. */
export const FIELD_LABEL = 'block text-sm font-heading font-semibold text-ink mb-1.5';

/** Standard text/textarea input. */
export const FIELD_INPUT = 'focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white text-ink';

/** Standard dropdown/combobox trigger (ListPicker / DatePicker style). */
export const FIELD_TRIGGER = 'w-full flex items-center justify-between gap-2 text-sm border border-gray-300 rounded-lg px-3 py-2.5 bg-white text-ink';

/** White content card. */
export const CARD = 'bg-white border border-gray-200 rounded-2xl';

/** Primary full-width action button — pass `enabled` to pick the active/disabled skin. */
export const primaryBtn = (enabled: boolean) =>
  `w-full rounded-2xl py-3.5 font-heading font-bold text-sm ${enabled ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`;
