/**
 * SaveIndicator — the ONE save-status chip shown in every inspection header
 * (Scope Rate Card, Re-Inspect QC, 1099, Community/Visit, …). Standardized so
 * the wording, icon, color, and sizing are identical across all templates:
 *
 *   saved / idle        → green "✓ Saved"
 *   dirty / saving      → brand "Saving…"
 *   offline             → gray  "Offline"
 *   error               → red   "Save failed" (tappable when onErrorClick given)
 *
 * Each form maps its own save state to a SavePhase (the union below), so the
 * underlying autosave machinery can differ while the UI never does.
 */
export type SavePhase = 'idle' | 'dirty' | 'saving' | 'saved' | 'offline' | 'error';

const CHECK = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

export function SaveIndicator({ phase, onErrorClick }: { phase: SavePhase; onErrorClick?: () => void }) {
  const base = 'inline-flex items-center gap-1.5 text-xs font-heading whitespace-nowrap';

  if (phase === 'saving' || phase === 'dirty') {
    return (
      <span className={`${base} font-semibold text-brand`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span>Saving&hellip;</span>
      </span>
    );
  }

  if (phase === 'offline') {
    return (
      <span className={`${base} font-semibold text-gray-500`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </svg>
        <span>Offline</span>
      </span>
    );
  }

  if (phase === 'error') {
    const inner = (
      <>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>Save failed</span>
      </>
    );
    return onErrorClick ? (
      <button type="button" onClick={onErrorClick} title="Tap for details"
              className={`${base} font-semibold text-red-700 hover:text-red-900 underline underline-offset-2`}>
        {inner}
      </button>
    ) : (
      <span className={`${base} font-semibold text-red-700`}>{inner}</span>
    );
  }

  // idle | saved → settled, "✓ Saved"
  return (
    <span className={`${base} text-green-700`}>
      <span className="text-green-600">{CHECK}</span>
      <span>Saved</span>
    </span>
  );
}
