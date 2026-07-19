// Per-service NOTES thread — the back-and-forth between the assigned vendor and
// the internal team, mounted on the service record page for both sides. Posting
// emails the note to the other party; replying to that email (from any mail
// client) lands back here via the notes-inbox cron.

import { useEffect, useRef, useState } from 'react';
import type { ServiceNote } from '@/lib/services/serviceNotes';

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(-2)} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

export function ServiceNotesThread({ serviceId, viewerRole }: {
  serviceId: string;
  /** Which side the CURRENT viewer is on — their bubbles right-align. */
  viewerRole: 'vendor' | 'internal';
}) {
  const [notes, setNotes] = useState<ServiceNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);   // collapsible, like the other sections
  // A hard reply-ingestion blocker reported by the server (e.g. the system
  // mailbox token lacks Gmail read scope) — shown to internal users only.
  const [inboxError, setInboxError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const r = await fetch(`/api/services/${serviceId}/notes`, { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(d.notes)) { setNotes(d.notes); setInboxError(d.inboxError || null); }
    } catch { /* keep whatever we have */ }
    finally { setLoading(false); }
  }
  // Initial load + a light poll while the section is expanded: each GET also
  // sweeps the mailbox for THIS service's replies (throttled server-side), so
  // an email reply lands in the thread within ~30s while someone's looking.
  useEffect(() => {
    void load();
    if (!open) return;
    const iv = window.setInterval(() => { void load(); }, 30_000);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, open]);

  async function send() {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true); setError(null);
    try {
      const r = await fetch(`/api/services/${serviceId}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setText('');
      if (d.note) setNotes((cur) => [...cur, d.note]);
      else void load();
      window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setSending(false); }
  }

  return (
    <section className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      {/* Collapsible header — mirrors the page's other sections. */}
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-4 py-2.5 bg-brand/5 border-b border-brand/20 text-left">
        <div className="font-heading font-bold text-lg text-ink truncate min-w-0">Notes</div>
        <div className="flex items-center gap-2 shrink-0">
          {notes.length > 0 && <span className="text-sm bg-brand text-white font-heading font-semibold px-2.5 py-0.5 rounded-full">{notes.length}</span>}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`text-gray-400 transition-transform ${open ? '' : '-rotate-90'}`}><polyline points="6 9 12 15 18 9" /></svg>
        </div>
      </button>
      {open && (<>
      <div className="p-3 space-y-2 max-h-80 overflow-y-auto">
        {loading ? (
          <p className="text-sm text-gray-400 text-center py-3">Loading notes…</p>
        ) : notes.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-3">No notes yet — start the conversation below.</p>
        ) : notes.map((n) => {
          const mine = n.role === viewerRole;
          return (
            <div key={n.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${mine ? 'bg-brand/10 border border-brand/20' : 'bg-gray-100 border border-gray-200'}`}>
                <div className="text-[11px] text-gray-500 mb-0.5">
                  <span className="font-heading font-semibold text-gray-700">{n.byName}</span>
                  {' · '}{fmtWhen(n.at)}{n.source === 'email' ? ' · via email' : ''}
                </div>
                <div className="text-sm text-ink whitespace-pre-wrap break-words">{n.text}</div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="border-t border-gray-100 p-3">
        {error && <p className="text-[12px] text-red-600 mb-1.5">Could not send: {error}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={viewerRole === 'vendor' ? 'Message the ResiHome team…' : 'Message the vendor…'}
            className="focus-brand flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white text-ink placeholder-gray-400 resize-none"
          />
          <button type="button" onClick={() => void send()} disabled={sending || !text.trim()}
            className="shrink-0 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-heading font-bold text-sm px-4 py-2.5 rounded-lg transition">
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5">The other side is emailed each note — they can reply right from the email.</p>
        {viewerRole === 'internal' && inboxError && (
          <p className="text-[11px] text-amber-600 mt-1">Reply-by-email sync is paused: {inboxError}</p>
        )}
      </div>
      </>)}
    </section>
  );
}
