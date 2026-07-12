// The standard sticky Save footer shared by both tabs of the Form Builder and
// the AI Knowledge Base, so Inspections and Services look identical. On the
// Services tabs it runs the bulk save (edits are staged locally); on the
// Inspections tabs every change already persists immediately, so it confirms
// "Saved ✓" — the affordance is the same either way.

export function SaveFooter({ label, onClick, busy = false, saved = false, disabled = false }: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  saved?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="sticky bottom-0 bg-gray-50 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <button type="button" onClick={onClick} disabled={disabled || busy}
        className="w-full rounded-2xl py-3 font-heading font-bold text-sm bg-brand text-white disabled:opacity-60">
        {busy ? 'Saving…' : saved ? 'Saved ✓' : label}
      </button>
    </div>
  );
}
