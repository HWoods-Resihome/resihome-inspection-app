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
import { SaveFooter } from '@/components/SaveFooter';
import { ListPicker } from '@/components/ListPicker';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readServiceAiChecks, readServiceTaxonomy } from '@/lib/hubspot';
import type { AiCheck } from '@/lib/services/aiKnowledge';
import type { CustomWorktypeDef } from '@/lib/services/worktypes';
import ServicesAiKnowledge from '@/pages/services/ai-knowledge';

// Loads the persisted Services AI checks so the "Services" tab renders inside
// this unified AI Knowledge page. Inspection entries still load client-side.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const admin = await isAppAdmin(session?.email).catch(() => false);
  const [servicesChecks, servicesTaxonomy] = admin
    ? await Promise.all([readServiceAiChecks().catch(() => null), readServiceTaxonomy().catch(() => null)])
    : [null, null];
  return { props: { servicesChecks: (servicesChecks as AiCheck[] | null) || null, servicesTaxonomy: (servicesTaxonomy as CustomWorktypeDef[] | null) || null } };
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
  template?: string;     // '' = all templates
  active?: boolean;      // absent/true = on
  meta?: { code?: string; samples?: number; accepts?: number; rejects?: number; examples?: string[] };
}

// Template scope options for inspection rules (mirrors the Services work-type
// scope). The knowledge feeds the Scope Rate Card camera AI.
const KB_TEMPLATES: { value: string; label: string }[] = [
  { value: '', label: 'All Templates' },
  { value: 'pm_scope_rate_card', label: 'Scope Rate Card' },
  { value: 'pm_turn_reinspect_qc', label: 'Turn Re-Inspect QC' },
  { value: 'pm_community_inspection', label: 'Community / Visit' },
  { value: 'pm_vacancy_occupancy_check', label: 'Vacancy / Occupancy' },
  { value: 'leasing_agent_1099_property_inspection', label: 'Leasing Agent' },
  { value: 'qc_new_construction_rrqc', label: 'New Construction RRQC' },
];
const kbTemplateLabel = (t?: string) => KB_TEMPLATES.find((o) => o.value === (t || ''))?.label || 'All Templates';
const KB_TRIG = 'w-full flex items-center justify-between gap-2 text-[13px] border border-gray-300 rounded-lg px-2.5 py-2 bg-white text-ink';

function fmtDate(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
}

export default function AiKnowledgePage({ servicesChecks, servicesTaxonomy }: { servicesChecks: AiCheck[] | null; servicesTaxonomy: CustomWorktypeDef[] | null }) {
  const router = useRouter();
  const [tab, setTab] = useState<'inspections' | 'services'>(router.query.tab === 'services' ? 'services' : 'inspections');
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // Inspections entries persist to HubSpot immediately; the footer just confirms,
  // matching the Services tab's bulk Save footer for a consistent look.
  const [savedTick, setSavedTick] = useState(false);
  const confirmSaved = () => { setSavedTick(true); window.setTimeout(() => setSavedTick(false), 2000); };
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editTemplate, setEditTemplate] = useState('');
  const [newText, setNewText] = useState('');
  const [newTemplate, setNewTemplate] = useState('');
  const [tplFilter, setTplFilter] = useState('');
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
    setBusy(true);
    try {
      const r = await fetch('/api/ai-knowledge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, template: newTemplate || undefined }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Add failed'); return; }
      setNewText(''); setNewTemplate('');
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
        body: JSON.stringify({ text, template: editTemplate }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Save failed'); return; }
      setEditingId(null);
      await load();
    } finally { setBusy(false); }
  }

  // On/Off — persist immediately (optimistic), like the per-entry save model.
  async function toggleActive(e: Entry) {
    const next = e.active === false; // currently off → turn on, else off
    setEntries((list) => (list || []).map((x) => (x.id === e.id ? { ...x, active: next } : x)));
    try {
      await fetch(`/api/ai-knowledge/${e.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: next }),
      });
    } catch { /* optimistic; reload will reconcile */ }
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
      <PageHeader title="AI Knowledge Base" onBack={() => (typeof window !== 'undefined' && window.history.length > 1 ? router.back() : router.push('/'))} backHref="/" maxW="max-w-3xl" />

      <main className="max-w-3xl mx-auto px-4 py-5">
        {/* Unified: Inspections knowledge base + Services AI review checks. */}
        <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold mb-4">
          {(['inspections', 'services'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`px-3.5 py-1.5 rounded-md capitalize ${tab === t ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>{t}</button>
          ))}
        </div>
        {tab === 'services' ? (
          <ServicesAiKnowledge embedded savedChecks={servicesChecks} savedTaxonomy={servicesTaxonomy} canSave={isAdmin} />
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

        {/* Add a rule. */}
        <div className="bg-white rounded-xl border border-gray-200 p-3 mb-5 shadow-sm">
          <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Add a rule</label>
          <textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={2}
            placeholder="e.g. “Gutter cleaning is always 100% tenant.”"
            className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm resize-y"
          />
          <div className="flex flex-wrap items-end gap-3 mt-2">
            <div className="w-52">
              <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Template</label>
              <ListPicker value={newTemplate} options={KB_TEMPLATES} ariaLabel="Template scope" className={KB_TRIG} onChange={setNewTemplate} />
            </div>
            <button
              type="button"
              onClick={addEntry}
              disabled={busy || !newText.trim()}
              className="ml-auto h-9 px-4 rounded-lg bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300"
            >
              Add rule
            </button>
          </div>
        </div>

        {/* Template filter. */}
        <div className="flex items-center gap-2 mb-3">
          <div className="w-52">
            <ListPicker value={tplFilter} options={[{ value: '', label: 'All Templates' }, ...KB_TEMPLATES.filter((t) => t.value)]} ariaLabel="Filter by template" className={KB_TRIG} onChange={setTplFilter} />
          </div>
        </div>

        {error && <div className="mb-4 p-3 bg-rose-50 border border-rose-300 rounded text-sm text-rose-800">{error}</div>}

        {entries === null ? (
          <div className="text-center text-gray-500 py-10 text-sm">Loading…</div>
        ) : entries.filter((e) => !tplFilter || (e.template || '') === tplFilter).length === 0 ? (
          <div className="text-center text-gray-500 py-10 text-sm">No knowledge entries{tplFilter ? ' for this template' : ' yet'}. Add one above, or use “Teach AI” in the camera.</div>
        ) : (
          <ul className="space-y-2.5">
            {entries.filter((e) => !tplFilter || (e.template || '') === tplFilter).map((e) => (
              <li key={e.id} className={`bg-white rounded-xl border border-gray-200 p-3 shadow-sm ${e.active === false ? 'opacity-60' : ''}`}>
                {editingId === e.id ? (
                  <>
                    <textarea
                      value={draft}
                      onChange={(ev) => setDraft(ev.target.value)}
                      rows={3}
                      className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm resize-y"
                    />
                    <div className="flex flex-wrap items-end gap-3 mt-2">
                      <div className="w-52">
                        <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Template</label>
                        <ListPicker value={editTemplate} options={KB_TEMPLATES} ariaLabel="Template scope" className={KB_TRIG} onChange={setEditTemplate} />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 mt-2">
                      <button type="button" onClick={() => setEditingId(null)} className="text-sm font-heading font-semibold text-gray-600 px-3 h-9">Cancel</button>
                      <button type="button" onClick={() => saveEdit(e.id)} disabled={busy || !draft.trim()} className="h-9 px-4 rounded-lg bg-emerald-600 text-white font-heading font-bold text-sm disabled:bg-gray-300">Save</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                      <span className="inline-flex items-center text-[10px] font-heading font-bold uppercase tracking-wide text-blue-700 bg-blue-100 border border-blue-200 rounded-full px-2 py-0.5">{kbTemplateLabel(e.template)}</span>
                      {e.source === 'auto' && (
                        <>
                          <span className="inline-flex items-center gap-1 text-[10px] font-heading font-bold uppercase tracking-wide text-violet-700 bg-violet-100 border border-violet-200 rounded-full px-2 py-0.5">✨ AI-learned</span>
                          {e.meta?.samples != null && (
                            <span className="text-[10px] text-gray-400" title={(e.meta.examples || []).join(' · ')}>
                              from {e.meta.samples} decision{e.meta.samples === 1 ? '' : 's'}
                              {e.meta.accepts != null && e.meta.rejects != null ? ` (${e.meta.accepts}✓ / ${e.meta.rejects}✗)` : ''}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    <p className="text-sm text-ink whitespace-pre-wrap">{e.text}</p>
                    <div className="flex items-center justify-between gap-2 mt-2">
                      <button type="button" onClick={() => toggleActive(e)}
                        className={`inline-flex items-center gap-1 text-xs font-heading font-semibold rounded-md px-2.5 py-1 border ${e.active === false ? 'text-gray-500 border-gray-300 bg-white' : 'text-emerald-700 border-emerald-300 bg-emerald-50'}`}>
                        {e.active === false ? 'Off' : 'On'}
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <button type="button" onClick={() => { setEditingId(e.id); setDraft(e.text); setEditTemplate(e.template || ''); }}
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
                    <div className="text-[11px] text-gray-500 truncate mt-1.5">
                      {(e.addedByName || e.addedByEmail || 'Unknown')}{e.createdAt ? ` · ${fmtDate(e.createdAt)}` : ''}{e.updatedAt ? (e.source === 'auto' ? '' : ' · edited') : ''}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <SaveFooter label="Save Knowledge Base" onClick={confirmSaved} saved={savedTick} />
        </>
        )}
      </main>
    </div>
  );
}
