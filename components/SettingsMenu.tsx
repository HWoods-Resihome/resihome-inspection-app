// The single, shared Settings gear for BOTH the Inspections home and the
// Services home. Extracted so the two apps show the *same* options and behave
// identically — the unified experience.
//
// ADMINS see the options grouped under three collapsible categories (all
// collapsed on open, tap a header to expand):
//   • Configuration — Form Builder, Rules Engine, Vendor Management
//   • Admin Tools   — Insights, AI Knowledge Base, Admin, View As
//   • General       — Training Guide, Notification Settings, Sign Out
// NON-ADMINS keep the short flat list (Training Guide + Notification Settings +
// Sign Out; vendors get just Notification Settings + Sign Out) — grouping three
// items would only add taps.
//
// The Form Builder and AI Knowledge links point at the unified tabbed pages
// (/admin/forms, /ai-knowledge) which host both the Inspections and Services
// variants as tabs.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { ViewAsPicker } from '@/components/ViewAsPicker';
import { clearCachedMe } from '@/lib/offlineCache';

const rowCls =
  'w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100';
// Rows inside an expanded category — indented under their header.
const groupRowCls =
  'w-full flex items-center gap-2.5 pl-6 pr-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100';

export function SettingsMenu({ isAdmin, isVendor, onOpen }: { isAdmin: boolean; isVendor?: boolean; onOpen?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [viewAsOpen, setViewAsOpen] = useState(false);
  // Which categories are expanded (admin menu). All start COLLAPSED each time
  // the menu opens — state resets because the menu unmounts on close.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleSection = (key: string) => setExpanded((s) => ({ ...s, [key]: !s[key] }));

  async function handleLogout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* offline */ }
    // Clear the cached identity so an OFFLINE reload after logout doesn't keep
    // rendering the app as the (now signed-out) user.
    clearCachedMe();
    router.replace('/login');
  }

  function openMenu() {
    setOpen((o) => {
      const next = !o;
      if (next) { onOpen?.(); setExpanded({}); } // fresh open → everything collapsed
      return next;
    });
  }

  // Collapsible category header (admin menu). Chevron rotates when expanded.
  const sectionHeader = (key: string, label: string) => (
    <button
      type="button"
      onClick={() => toggleSection(key)}
      aria-expanded={!!expanded[key]}
      className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-[11px] font-heading font-bold uppercase tracking-wide text-brand bg-brand/5 hover:bg-brand/10 transition-colors border-t border-brand/20"
    >
      {label}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        className={`shrink-0 text-brand/60 transition-transform ${expanded[key] ? 'rotate-180' : ''}`}>
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );

  // The individual option rows, shared between the flat (non-admin) menu and
  // the grouped (admin) menu — only the row class differs.
  const trainingRow = (cls: string): ReactNode => (
    <Link href="/guide" onClick={() => setOpen(false)} className={cls}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
      Training Guide
    </Link>
  );
  const notificationsRow = (cls: string): ReactNode => (
    <Link href="/notifications" onClick={() => setOpen(false)} className={cls}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
      Notifications
    </Link>
  );
  const signOutRow = (cls: string): ReactNode => (
    <button type="button" onClick={() => { setOpen(false); void handleLogout(); }} className={cls}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
      Sign Out
    </button>
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={openMenu}
        aria-expanded={open}
        aria-label="Settings"
        title="Settings"
        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>
      {open && (
        <>
          <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1.5 z-50 w-56 rounded-xl border border-gray-200 bg-white shadow-lg ring-1 ring-black/5 overflow-hidden py-1">
            {isAdmin ? (
              <>
                {/* ── Configuration — the build/setup consoles. */}
                {sectionHeader('config', 'Configuration')}
                {expanded['config'] && (
                  <>
                    <Link href="/admin/forms" onClick={() => setOpen(false)} className={groupRowCls}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></svg>
                      Form Builder
                    </Link>
                    <Link href="/services/rules" onClick={() => setOpen(false)} className={groupRowCls}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><circle cx="12" cy="12" r="3" /><path d="M12 1v6m0 6v6M4.2 4.2l4.3 4.3m6.9 6.9l4.3 4.3M1 12h6m6 0h6M4.2 19.8l4.3-4.3m6.9-6.9l4.3-4.3" /></svg>
                      Rules Engine
                    </Link>
                    <Link href="/admin/vendors" onClick={() => setOpen(false)} className={groupRowCls}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                      Vendor Management
                    </Link>
                  </>
                )}

                {/* ── Admin Tools — day-to-day admin utilities. */}
                {sectionHeader('tools', 'Admin Tools')}
                {expanded['tools'] && (
                  <>
                    <Link href="/admin/flows" onClick={() => setOpen(false)} className={groupRowCls}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
                      Admin
                    </Link>
                    <Link href="/ai-knowledge" onClick={() => setOpen(false)} className={groupRowCls}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>
                      AI Knowledge Base
                    </Link>
                    {/* From the Services app, Insights opens directly on its
                        Services tab; from Inspections, the Inspections tab. */}
                    <Link href={router.pathname.startsWith('/services') ? '/insights?tab=services' : '/insights'} onClick={() => setOpen(false)} className={groupRowCls}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
                      Insights
                    </Link>
                    <button type="button" onClick={() => { setOpen(false); setViewAsOpen(true); }} className={groupRowCls}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M1 1l22 22" /></svg>
                      View As
                    </button>
                  </>
                )}

                {/* ── General — personal/account items. */}
                {sectionHeader('general', 'General')}
                {expanded['general'] && (
                  <>
                    {notificationsRow(groupRowCls)}
                    {trainingRow(groupRowCls)}
                    {signOutRow(groupRowCls)}
                  </>
                )}
              </>
            ) : (
              <>
                {/* Non-admins: the short flat list. Vendors get a minimal menu:
                    Notification Settings + Sign Out only. */}
                {!isVendor && trainingRow(rowCls)}
                {notificationsRow(rowCls)}
                {signOutRow(rowCls)}
              </>
            )}
          </div>
        </>
      )}
      {viewAsOpen && <ViewAsPicker onClose={() => setViewAsOpen(false)} />}
    </div>
  );
}
