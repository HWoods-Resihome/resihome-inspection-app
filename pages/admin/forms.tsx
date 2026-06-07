/**
 * /admin/forms — the form/template builder.
 *
 * Admins pick a question-driven template and add / edit / reorder / toggle /
 * remove its questions and change answer types — all syncing to HubSpot.
 * Scope Rate Card and Turn Re-Inspect QC are intentionally NOT listed (locked).
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { Question, ResponseType } from '@/lib/types';
import { EDITABLE_TEMPLATES, RESPONSE_TYPES } from '@/lib/formBuilder';

type Draft = {
  questionText: string;
  section: string;
  sectionOrder: number;
  displayOrder: number;
  responseType: ResponseType;
  responseOptionsText: string; // newline/comma separated in the UI
  isRequired: boolean;
  helpText: string;
  enabled: boolean;
};

const blankDraft = (section = '', sectionOrder = 0): Draft => ({
  questionText: '', section, sectionOrder, displayOrder: 0,
  responseType: 'text', responseOptionsText: '', isRequired: false, helpText: '', enabled: true,
});

const toOptions = (s: string): string[] => s.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
const fromQuestion = (q: Question): Draft => ({
  questionText: q.questionText, section: q.section, sectionOrder: q.sectionOrder, displayOrder: q.displayOrder,
  responseType: q.responseType, responseOptionsText: q.responseOptions.join('\n'),
  isRequired: q.isRequired, helpText: q.helpText, enabled: q.enabled,
});

function QuestionEditor({ initial, template, onSave, onCancel, busy }: {
  initial: Draft; template: string; onSave: (d: Draft) => void; onCancel: () => void; busy: boolean;
}) {
  const [d, setD] = useState<Draft>(initial);
  const typeMeta = RESPONSE_TYPES.find((t) => t.value === d.responseType);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  return (
    <div className="rounded-lg border border-brand/40 bg-brand/5 p-3 space-y-2.5">
      <textarea value={d.questionText} onChange={(e) => set({ questionText: e.target.value })} rows={2}
        placeholder="Question text" className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm" />
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] font-heading font-semibold text-gray-500">Section
          <input value={d.section} onChange={(e) => set({ section: e.target.value })} className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm mt-0.5" />
        </label>
        <label className="text-[11px] font-heading font-semibold text-gray-500">Answer type
          <select value={d.responseType} onChange={(e) => set({ responseType: e.target.value as ResponseType })} className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm mt-0.5 bg-white">
            {RESPONSE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="text-[11px] font-heading font-semibold text-gray-500">Section order
          <input type="number" value={d.sectionOrder} onChange={(e) => set({ sectionOrder: Number(e.target.value) })} className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm mt-0.5" />
        </label>
        <label className="text-[11px] font-heading font-semibold text-gray-500">Display order
          <input type="number" value={d.displayOrder} onChange={(e) => set({ displayOrder: Number(e.target.value) })} className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm mt-0.5" />
        </label>
      </div>
      {typeMeta?.hasOptions && (
        <label className="block text-[11px] font-heading font-semibold text-gray-500">Choices (one per line)
          <textarea value={d.responseOptionsText} onChange={(e) => set({ responseOptionsText: e.target.value })} rows={3}
            placeholder={'Good\nFair\nPoor'} className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm mt-0.5" />
        </label>
      )}
      <label className="block text-[11px] font-heading font-semibold text-gray-500">Help text (optional)
        <input value={d.helpText} onChange={(e) => set({ helpText: e.target.value })} className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm mt-0.5" />
      </label>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" checked={d.isRequired} onChange={(e) => set({ isRequired: e.target.checked })} /> Required</label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="text-sm font-heading font-semibold text-gray-600 px-3 h-9">Cancel</button>
        <button type="button" onClick={() => onSave(d)} disabled={busy || !d.questionText.trim()}
          className="h-9 px-4 rounded-lg bg-brand text-white font-heading font-bold text-sm disabled:bg-gray-300">Save</button>
      </div>
    </div>
  );
}

export default function FormBuilderPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [template, setTemplate] = useState<string>(EDITABLE_TEMPLATES[0].id);
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((data) => {
      setIsAdmin(!!data.authenticated && !!data.isAdmin);
      setAuthChecked(true);
      if (!data.authenticated) router.replace('/login');
    }).catch(() => setAuthChecked(true));
  }, [router]);

  async function load() {
    setQuestions(null);
    try {
      const r = await fetch(`/api/admin/questions?template=${encodeURIComponent(template)}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); setQuestions([]); return; }
      setQuestions(d.questions || []);
      setError(null);
    } catch (e: any) { setError(String(e?.message || e)); setQuestions([]); }
  }
  useEffect(() => { if (isAdmin) load(); /* eslint-disable-next-line */ }, [isAdmin, template]);

  const grouped = useMemo(() => {
    const m = new Map<string, Question[]>();
    for (const q of questions || []) { const k = q.section || '(no section)'; (m.get(k) || m.set(k, []).get(k)!).push(q); }
    return Array.from(m.entries());
  }, [questions]);

  async function saveEdit(id: string, d: Draft) {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/questions/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...d, responseOptions: toOptions(d.responseOptionsText) }),
      });
      const dd = await r.json();
      if (!r.ok) { setError(dd.error || 'Save failed'); return; }
      setEditingId(null); setError(null); await load();
    } finally { setBusy(false); }
  }

  async function create(d: Draft) {
    setBusy(true);
    try {
      const r = await fetch('/api/admin/questions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...d, responseOptions: toOptions(d.responseOptionsText), appliesToTemplates: [template] }),
      });
      const dd = await r.json();
      if (!r.ok) { setError(dd.error || 'Create failed'); return; }
      setAdding(false); setError(null); await load();
    } finally { setBusy(false); }
  }

  async function toggleEnabled(q: Question) {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/questions/${q.hubspotRecordId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !q.enabled }),
      });
      const dd = await r.json();
      if (!r.ok) { setError(dd.error || 'Update failed'); return; }
      setError(null); await load();
    } finally { setBusy(false); }
  }

  async function remove(q: Question) {
    if (!confirm(`Remove “${q.questionText.slice(0, 60)}”? It will be archived in HubSpot.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/questions/${q.hubspotRecordId}`, { method: 'DELETE' });
      const dd = await r.json();
      if (!r.ok) { setError(dd.error || 'Remove failed'); return; }
      setError(null); await load();
    } finally { setBusy(false); }
  }

  if (!authChecked) return null;
  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div><p className="text-gray-700 font-heading font-semibold mb-2">Admin only</p><Link href="/" className="text-brand underline text-sm">Back to inspections</Link></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-brand text-white">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></svg>
            <h1 className="font-heading font-extrabold text-lg tracking-tight truncate">Form Builder</h1>
          </div>
          <Link href="/" className="text-xs font-heading font-semibold text-white/90 hover:text-white shrink-0">← Inspections</Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-5">
        <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Template</label>
        <select value={template} onChange={(e) => { setEditingId(null); setAdding(false); setTemplate(e.target.value); }}
          className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm bg-white mb-3">
          {EDITABLE_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <p className="text-[12px] text-gray-500 mb-4">Scope Rate Card and Turn Re-Inspect QC are locked and not editable here. Changes sync to HubSpot and apply to new inspections immediately.</p>

        {error && <div className="mb-4 p-3 bg-rose-50 border border-rose-300 rounded text-sm text-rose-800">{error}</div>}

        <div className="flex justify-end mb-3">
          <button type="button" onClick={() => { setAdding(true); setEditingId(null); }} disabled={adding}
            className="h-9 px-4 rounded-lg bg-brand text-white font-heading font-bold text-sm disabled:bg-gray-300">+ Add question</button>
        </div>

        {adding && (
          <div className="mb-4">
            <QuestionEditor initial={blankDraft()} template={template} busy={busy}
              onSave={create} onCancel={() => setAdding(false)} />
          </div>
        )}

        {questions === null ? (
          <div className="text-center text-gray-500 py-10 text-sm">Loading…</div>
        ) : questions.length === 0 ? (
          <div className="text-center text-gray-500 py-10 text-sm">No questions for this template yet. Add one above.</div>
        ) : (
          <div className="space-y-5">
            {grouped.map(([section, qs]) => (
              <div key={section}>
                <h2 className="text-xs font-heading font-bold text-gray-500 uppercase tracking-wide mb-1.5">{section}</h2>
                <ul className="space-y-2">
                  {qs.map((q) => (
                    <li key={q.hubspotRecordId} className={`bg-white rounded-xl border p-3 shadow-sm ${q.enabled ? 'border-gray-200' : 'border-gray-200 opacity-60'}`}>
                      {editingId === q.hubspotRecordId ? (
                        <QuestionEditor initial={fromQuestion(q)} template={template} busy={busy}
                          onSave={(d) => saveEdit(q.hubspotRecordId, d)} onCancel={() => setEditingId(null)} />
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-ink leading-snug">{q.questionText || <span className="text-gray-400 italic">(no text)</span>}</div>
                              <div className="text-[11px] text-gray-500 mt-0.5">
                                {RESPONSE_TYPES.find((t) => t.value === q.responseType)?.label || q.responseType}
                                {q.isRequired ? ' · required' : ''}{!q.enabled ? ' · disabled' : ''}
                                {q.responseOptions.length ? ` · ${q.responseOptions.length} choices` : ''}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button type="button" onClick={() => toggleEnabled(q)} disabled={busy}
                                title={q.enabled ? 'Turn off' : 'Turn on'}
                                className={`text-xs font-heading font-semibold rounded-md px-2 py-1 border ${q.enabled ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-gray-600 bg-gray-100 border-gray-200'}`}>
                                {q.enabled ? 'On' : 'Off'}
                              </button>
                              <button type="button" onClick={() => { setEditingId(q.hubspotRecordId); setAdding(false); }}
                                className="text-xs font-heading font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md px-2.5 py-1">Edit</button>
                              <button type="button" onClick={() => remove(q)} disabled={busy}
                                className="text-xs font-heading font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md px-2.5 py-1">Delete</button>
                            </div>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
