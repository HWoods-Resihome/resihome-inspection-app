// Small sparkle glyph used to mark AI activity (e.g. next to "Submitted" while a
// completion is under AI review). Internal-only affordance.
export function AiSparkle({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2l1.7 4.3L18 8l-4.3 1.7L12 14l-1.7-4.3L6 8l4.3-1.7z" />
      <path d="M18.5 13.5l.85 2 2 .85-2 .85-.85 2-.85-2-2-.85 2-.85z" />
    </svg>
  );
}
