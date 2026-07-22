/**
 * components/sitepreview/Logos.tsx — simplified, recognizable SVG marks for the
 * services ResiWalk integrates with, for the integrations grid. Original vector
 * approximations (nominative use to indicate genuine integrations) — not copied
 * asset files.
 */
type P = { className?: string };

export const HubSpotMark = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden fill="none">
    <circle cx="22" cy="10" r="4.4" fill="#FF7A59" />
    <circle cx="22" cy="10" r="1.7" fill="#fff" />
    <path d="M22 14.4V19" stroke="#33475B" strokeWidth="2.2" strokeLinecap="round" />
    <circle cx="12" cy="22" r="6" stroke="#33475B" strokeWidth="2.2" />
    <path d="M16.2 17.8 20 14" stroke="#33475B" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

export const DriveMark = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <path d="M11.4 4h9.2l9.4 16.3H21.4z" fill="#FFCF63" />
    <path d="M11.4 4 2 20.3 6.6 28l9.4-16.3z" fill="#12A150" />
    <path d="M6.6 28h18.8l4.6-7.7H11.4z" fill="#3B82F6" />
  </svg>
);

export const CalendarMark = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <rect x="6" y="6" width="20" height="20" rx="3" fill="#fff" stroke="#E4E7EC" strokeWidth="1.5" />
    <path d="M6 9a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v2H6z" fill="#4285F4" />
    <rect x="9.5" y="14" width="4" height="4" rx="1" fill="#EA4335" />
    <rect x="14.5" y="14" width="4" height="4" rx="1" fill="#FBBC04" />
    <rect x="19.5" y="14" width="3" height="4" rx="1" fill="#34A853" />
    <rect x="9.5" y="19.5" width="4" height="3.5" rx="1" fill="#34A853" />
    <rect x="14.5" y="19.5" width="4" height="3.5" rx="1" fill="#4285F4" />
  </svg>
);

export const SlackMark = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <g>
      <path d="M13 6.5a2.5 2.5 0 1 1-2.5 2.5V6.5z" fill="#36C5F0" />
      <path d="M9 13a2.5 2.5 0 1 1 0-5h6.5a2.5 2.5 0 0 1 0 5z" fill="#36C5F0" />
      <path d="M25.5 13a2.5 2.5 0 1 1-2.5-2.5h2.5z" fill="#2EB67D" />
      <path d="M19 9a2.5 2.5 0 1 1 5 0v6.5a2.5 2.5 0 0 1-5 0z" fill="#2EB67D" />
      <path d="M19 25.5A2.5 2.5 0 1 1 21.5 23H19z" fill="#ECB22E" />
      <path d="M23 19a2.5 2.5 0 1 1 0 5h-6.5a2.5 2.5 0 0 1 0-5z" fill="#ECB22E" />
      <path d="M6.5 19A2.5 2.5 0 1 1 9 21.5H6.5z" fill="#E01E5A" />
      <path d="M13 23a2.5 2.5 0 1 1-5 0v-6.5a2.5 2.5 0 0 1 5 0z" fill="#E01E5A" />
    </g>
  </svg>
);

export const GoogleMark = ({ className }: P) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden>
    <path d="M27 16.3c0-.8-.07-1.5-.2-2.3H16v4.3h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7C25.8 22.7 27 19.8 27 16.3z" fill="#4285F4" />
    <path d="M16 28c3 0 5.6-1 7.4-2.7l-3.7-2.9c-1 .7-2.3 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.6H5.9v2.9A11 11 0 0 0 16 28z" fill="#34A853" />
    <path d="M9.8 18.9a6.6 6.6 0 0 1 0-4.2v-2.9H5.9a11 11 0 0 0 0 10z" fill="#FBBC04" />
    <path d="M16 9.9c1.6 0 3 .6 4.2 1.7l3.1-3.1A11 11 0 0 0 5.9 11.8l3.9 2.9C10.7 11.8 13.1 9.9 16 9.9z" fill="#EA4335" />
  </svg>
);

/** Text-wordmark chip for partners without a simple mark. */
export const WordMark = ({ label, color = '#0f172a', className }: { label: string; color?: string } & P) => (
  <span className={className} style={{ color, fontWeight: 800, letterSpacing: '-0.02em' }}>{label}</span>
);
