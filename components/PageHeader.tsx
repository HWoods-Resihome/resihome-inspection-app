// The standard app sub-page header: the brand-pink bar with the ResiWalk logo +
// page title CENTERED, an optional back control pinned left, and optional
// right-side controls pinned right. Shared by the New Service / New Inspection
// entry screens and the secondary admin/detail pages so every screen wears the
// same chrome. (App home screens keep their own header with the full control
// row; this is for the focused sub-pages.)

import Link from 'next/link';
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  backHref,
  onBack,
  backLabel = 'Back',
  homeHref,
  right,
  maxW = 'max-w-2xl',
}: {
  title: string;
  /** Back target. Omit both backHref and onBack to hide the back control. */
  backHref?: string;
  onBack?: () => void;
  backLabel?: string;
  /** Where the logo tap goes — the current app's home. Defaults to backHref. */
  homeHref?: string;
  right?: ReactNode;
  /** Content max-width to match the page body below it. */
  maxW?: string;
}) {
  const logoHref = homeHref || backHref;
  const chevron = (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
  );
  return (
    <header className="bg-brand text-white sticky top-0 z-20" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
      <div className={`${maxW} mx-auto px-4 pt-2 pb-2.5 relative flex items-center justify-center min-h-[40px]`}>
        {(backHref || onBack) && (
          onBack ? (
            <button type="button" onClick={onBack} aria-label={backLabel}
              className="absolute left-4 top-1/2 -translate-y-1/2 inline-flex items-center text-white/90 hover:text-white">
              {chevron}
            </button>
          ) : (
            <Link href={backHref!} aria-label={backLabel}
              className="absolute left-4 top-1/2 -translate-y-1/2 inline-flex items-center text-white/90 hover:text-white">
              {chevron}
            </Link>
          )
        )}
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Logo → the current app's home (stays in-app). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {logoHref ? (
            <Link href={logoHref} aria-label="Home" className="shrink-0">
              <img src="/app-icon.svg" alt="ResiWalk" className="h-9 w-9 object-cover" />
            </Link>
          ) : (
            <img src="/app-icon.svg" alt="ResiWalk" className="h-9 w-9 object-cover shrink-0" />
          )}
          <h1 className="font-heading font-extrabold text-lg tracking-tight truncate">{title}</h1>
        </div>
        {right && <div className="absolute right-4 top-1/2 -translate-y-1/2">{right}</div>}
      </div>
    </header>
  );
}
