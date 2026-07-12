/**
 * /ai-knowledge — admin screen to review and curate the AI knowledge base.
 *
 * Lists every field-trained entry (who added it, when), and lets an admin edit,
 * delete, or add entries. These feed the LIVE in-camera call-out model. Gated to
 * @resihome.com staff (the API enforces this too).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readServiceAiChecks } from '@/lib/hubspot';
import type { AiCheck } from '@/lib/services/aiKnowledge';
import ServicesAiKnowledge from '@/pages/services/ai-knowledge';

// Loads the persisted Services AI checks so the "Services" tab renders inside
// this unified AI Knowledge page. Inspection entries still load client-side.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const admin = await isAppAdmin(session?.email).catch(() => false);
  const servicesChecks = admin ? await readServiceAiChecks().catch(() => null) : null;
  return { props: { servicesChecks: (servicesChecks as AiCheck[] | null) || null } };
};

interface Entry {
  id: string;
  text: string;
  addedByEmail: string;
  addedByName?: string;
  createdAt: number;
  updatedAt?: number;
  source?: 'inspector' | 'admin' | 'auto';
  status?: 'active' | 'dismissed';
  kind?: 'rule' | 'example';
  expected?: string;
  meta?: { code?: string; samples?: number; accepts?: number; rejects?: number; examples?: string[] };
}

function fmtDate(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
}

export default function AiKnowledgePage({ servicesChecks }: { servicesChecks: AiCheck[] | null }) {
  const router = useRouter();
  const [tab, setTab] = useState<'inspections' | 'services'>(router.query.tab === 'services' ? 'services' : 'inspections');
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftExpected, setDraftExpected] = useState('');
  const [draftIsExample, setDraftIsExample] = useState(false);
  const [newText, setNewText] = useState('');
  const [newExpected, setNewExpected] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        setIsAdmin(!!data.authenticated && !!data.isAdmin);
        setAuthChecked(true);
        if (!data.authenticated) router.replace('/login');
      })
      .catch(() => setAuthChecked(true));
  }, [router]);

  async function load() {
    try {
      const r = await fetch('/api/ai-knowledge', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); return; }
      // Hide dismissed auto entries (tombstones kept server-side so the loop
      // won't re-add them).
      setEntries((d.entries || []).filter((e: Entry) => e.status !== 'dismissed'));
      setError(null);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  // Synthesize learned entries from captured feedback right now (instead of
  // waiting for the daily cron), then refresh the list so they're reviewable.
  const [learnMsg, setLearnMsg] = useState<string | null>(null);
  async function learnNow() {
    setBusy(true); setLearnMsg(null); setError(null);
    try {
      const r = await fetch('/api/admin/ai-learning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Learn failed'); return; }
      const k = d.knowledge || {};
      setLearnMsg(`Learned from feedback: ${k.added ?? 0} new, ${k.refreshed ?? 0} updated${k.skipped ? `, ${k.skipped} previously dismissed` : ''}.`);
      await load();
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  }

  async function addEntry() {
    const text = newText.trim();
    if (!text) return;
    const expected = newExpected.trim();
    setBusy(true);
    try {
      const r = await fetch('/api/ai-knowledge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, expected: expected || undefined }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Add failed'); return; }
      setNewText('');
      setNewExpected('');
      await load();
    } finally { setBusy(false); }
  }

  async function saveEdit(id: string) {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/ai-knowledge/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftIsExample ? { text, expected: draftExpected.trim() } : { text }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Save failed'); return; }
      setEditingId(null);
      await load();
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this knowledge entry? The AI will stop using it.')) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/ai-knowledge/${id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Delete failed'); return; }
      await load();
    } finally { setBusy(false); }
  }

  if (!authChecked) return null;
  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-gray-700 font-heading font-semibold mb-2">Admin only</p>
          <Link href="/" className="text-brand underline text-sm">Back to inspections</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader title="AI Knowledge Base" backHref="/" maxW="max-w-3xl" />

      <main className="max-w-3xl mx-auto px-4 py-5">
        {/* Unified: Inspections knowledge base + Services AI review checks. */}
        <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold mb-4">
          {(['inspections', 'services'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`px-3.5 py-1.5 rounded-md capitalize ${tab === t ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>{t}</button>
          ))}
        </div>
        {tab === 'services' ? (
          <ServicesAiKnowledge embedded savedChecks={servicesChecks} canSave={isAdmin} />
        ) : (
        <>
        <p className="text-[13px] text-gray-600 mb-4 leading-snug">
          Guidance the <strong>AI</strong> uses for its call-outs, edits, and voice matching. Inspectors add entries by voice (“Teach AI” in the camera), and the AI <strong>auto-learns</strong> entries (marked <span className="text-violet-700 font-semibold">✨ AI-learned</span>) from how inspectors accept or reject its suggestions. Edit any entry to adopt and refine it, or delete it to stop the AI using it.
        </p>

        {/* Learn now: synthesize entries from captured feedback on demand. */}
        <div className="bg-violet-50 border border-violet-200 rounded-xl p-3 mb-5 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-[13px] text-violet-900 min-w-0">
            <span className="font-heading font-semibold">Learn from feedback now</span>
            <span className="block text-violet-700/80 text-xs">Turn what inspectors have accepted/rejected into reviewable ✨ AI-learned entries (runs nightly too).</span>
            {learnMsg && <span className="block text-xs text-emerald-700 font-heading font-semibold mt-1">{learnMsg}</span>}
          </div>
          <button type="button" onClick={learnNow} disabled={busy}
            className="h-9 px-4 rounded-lg bg-violet-600 text-white font-heading font-bold text-sm hover:bg-violet-700 disabled:bg-gray-300 shrink-0">
            {busy ? 'Learning…' : 'Learn now'}
          </button>
        </div>

        {/* Add new — a plain rule, OR a worked example (fill in the expected action). */}
        <div className="bg-white rounded-xl border border-gray-200 p-3 mb-5 shadow-sm">
          <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Add a rule, or a worked example</label>
          <textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={2}
            placeholder="Rule, e.g. “Gutter cleaning is always 100% tenant.”  —  OR what the inspector says, e.g. “whole house mismatch”"
            className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm resize-y"
          />
          <label className="block text-xs font-heading font-semibold text-gray-500 mt-2 mb-1">Correct action <span className="font-normal text-gray-400">(optional — fill in to make this a worked example)</span></label>
          <textarea
            value={newExpected}
            onChange={(e) => setNewExpected(e.target.value)}
            rows={2}
            placeholder="e.g. Mist-match paint for the whole house; route to Whole House and use the property sqft — don’t ask for square feet."
            className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm resize-y"
          />
          <div className="flex justify-end mt-2">
            <button
              type="button"
              onClick={addEntry}
              disabled={busy || !newText.trim()}
              className="h-9 px-4 rounded-lg bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300"
            >
              {newExpected.trim() ? 'Add example' : 'Add rule'}
            </button>
          </div>
        </div>

        {error && <div className="mb-4 p-3 bg-rose-50 border border-rose-300 rounded text-sm text-rose-800">{error}</div>}

        {entries === null ? (
          <div className="text-center text-gray-500 py-10 text-sm">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-center text-gray-500 py-10 text-sm">No knowledge entries yet. Add one above, or use “Teach AI” in the camera.</div>
        ) : (
          <ul className="space-y-2.5">
            {entries.map((e) => (
              <li key={e.id} className="bg-white rounded-xl border border-gray-200 p-3 shadow-sm">
                {editingId === e.id ? (
                  <>
                    {draftIsExample && <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Inspector says</label>}
                    <textarea
                      value={draft}
                      onChange={(ev) => setDraft(ev.target.value)}
                      rows={draftIsExample ? 2 : 3}
                      className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm resize-y"
                    />
                    {draftIsExample && (
                      <>
                        <label className="block text-xs font-heading font-semibold text-gray-500 mt-2 mb-1">Correct action</label>
                        <textarea
                          value={draftExpected}
                          onChange={(ev) => setDraftExpected(ev.target.value)}
                          rows={2}
                          className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm resize-y"
                        />
                      </>
                    )}
                    <div className="flex justify-end gap-2 mt-2">
                      <button type="button" onClick={() => setEditingId(null)} className="text-sm font-heading font-semibold text-gray-600 px-3 h-9">Cancel</button>
                      <button type="button" onClick={() => saveEdit(e.id)} disabled={busy || !draft.trim()} className="h-9 px-4 rounded-lg bg-emerald-600 text-white font-heading font-bold text-sm disabled:bg-gray-300">Save</button>
                    </div>
                  </>
                ) : (
                  <>
                    {e.source === 'auto' && (
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="inline-flex items-center gap-1 text-[10px] font-heading font-bold uppercase tracking-wide text-violet-700 bg-violet-100 border border-violet-200 rounded-full px-2 py-0.5">✨ AI-learned</span>
                        {e.meta?.samples != null && (
                          <span className="text-[10px] text-gray-400" title={(e.meta.examples || []).join(' · ')}>
                            from {e.meta.samples} decision{e.meta.samples === 1 ? '' : 's'}
                            {e.meta.accepts != null && e.meta.rejects != null ? ` (${e.meta.accepts}✓ / ${e.meta.rejects}✗)` : ''}
                          </span>
                        )}
                      </div>
                    )}
                    {e.kind === 'example' ? (
                      <div>
                        <span className="inline-flex items-center gap-1 text-[10px] font-heading font-bold uppercase tracking-wide text-sky-700 bg-sky-100 border border-sky-200 rounded-full px-2 py-0.5 mb-1.5">◎ Worked example</span>
                        <p className="text-sm text-ink"><span className="text-gray-500">Inspector says:</span> “{e.text}”</p>
                        <p className="text-sm text-ink mt-0.5"><span className="text-gray-500">Correct action:</span> {e.expected}</p>
                      </div>
                    ) : (
                      <p className="text-sm text-ink whitespace-pre-wrap">{e.text}</p>
                    )}
                    <div className="flex items-center justify-between gap-2 mt-2">
                      <div className="text-[11px] text-gray-500 truncate">
                        {(e.addedByName || e.addedByEmail || 'Unknown')}{e.createdAt ? ` · ${fmtDate(e.createdAt)}` : ''}{e.updatedAt ? (e.source === 'auto' ? '' : ' · edited') : ''}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button type="button" onClick={() => { setEditingId(e.id); setDraft(e.text); setDraftIsExample(e.kind === 'example'); setDraftExpected(e.expected || ''); }}
                          className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md px-2.5 py-1">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                          Edit
                        </button>
                        <button type="button" onClick={() => remove(e.id)}
                          className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md px-2.5 py-1">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>
                          Delete
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        </>
        )}
      </main>
    </div>
  );
}
