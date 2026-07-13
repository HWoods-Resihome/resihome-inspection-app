// The single, shared Settings gear for BOTH the Inspections home and the
// Services home. Extracted so the two apps show the *same* options and behave
// identically — the unified experience. Every user sees Training Guide + Sign
// Out; admins additionally get the tools block (Insights, AI Knowledge,
// Form Builder, Rules Engine, Rerun AI Review, Admin, View as User / Vendor).
//
// The Form Builder and AI Knowledge links point at the unified tabbed pages
// (/admin/forms, /ai-knowledge) which host both the Inspections and Services
// variants as tabs.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { ViewAsPicker } from '@/components/ViewAsPicker';
import { clearCachedMe } from '@/lib/offlineCache';

const rowCls =
  'w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100';

export function SettingsMenu({ isAdmin, onOpen }: { isAdmin: boolean; onOpen?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [viewAsOpen, setViewAsOpen] = useState(false);

  async function handleLogout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* offline */ }
    // Clear the cached identity so an OFFLINE reload after logout doesn't keep
    // rendering the app as the (now signed-out) user.
    clearCachedMe();
    router.replace('/login');
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => { const next = !o; if (next) onOpen?.(); return next; })}
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
            {/* Training guide — available to ALL users. Opens in-app. */}
            <Link href="/guide" onClick={() => setOpen(false)} className={rowCls}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
              Training Guide
            </Link>
            {/* Notification Settings — every user manages their own email alerts. */}
            <Link href="/notifications" onClick={() => setOpen(false)} className={rowCls}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
              Notification Settings
            </Link>
            {/* Admin tools — admins only. Identical across Inspections & Services. */}
            {isAdmin && (
              <>
                <Link href="/insights" onClick={() => setOpen(false)} className={rowCls}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
                  Insights
                </Link>
                <Link href="/ai-knowledge" onClick={() => setOpen(false)} className={rowCls}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>
                  AI Knowledge Base
                </Link>
                <Link href="/admin/forms" onClick={() => setOpen(false)} className={rowCls}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></svg>
                  Form Builder
                </Link>
                <Link href="/services/rules" onClick={() => setOpen(false)} className={rowCls}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><circle cx="12" cy="12" r="3" /><path d="M12 1v6m0 6v6M4.2 4.2l4.3 4.3m6.9 6.9l4.3 4.3M1 12h6m6 0h6M4.2 19.8l4.3-4.3m6.9-6.9l4.3-4.3" /></svg>
                  Rules Engine
                </Link>
                <Link href="/services/billing" onClick={() => setOpen(false)} className={rowCls}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /><line x1="6" y1="15" x2="10" y2="15" /></svg>
                  Billing
                </Link>
                <Link href="/admin/flows" onClick={() => setOpen(false)} className={rowCls}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>
                  Admin
                </Link>
                <button type="button" onClick={() => { setOpen(false); setViewAsOpen(true); }} className={rowCls}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M1 1l22 22" /></svg>
                  View As
                </button>
              </>
            )}
            {/* Sign Out — last, divided from the rest. */}
            <button type="button" onClick={() => { setOpen(false); void handleLogout(); }} className={rowCls}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
              Sign Out
            </button>
          </div>
        </>
      )}
      {viewAsOpen && <ViewAsPicker onClose={() => setViewAsOpen(false)} />}
    </div>
  );
}
