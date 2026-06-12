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
import { RESPONSE_TYPES, STANDARD_SECTIONS } from '@/lib/formBuilder';
import { Combobox } from '@/components/Combobox';

interface TemplateInfo { id: string; label: string; custom: boolean; }

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
  requiresPhoto: boolean;
  requiresNote: boolean;
};

const blankDraft = (section = '', sectionOrder = 0): Draft => ({
  questionText: '', section, sectionOrder, displayOrder: 0,
  responseType: 'text', responseOptionsText: '', isRequired: false, helpText: '', enabled: true, requiresPhoto: false, requiresNote: false,
});

const toOptions = (s: string): string[] => s.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
const fromQuestion = (q: Question): Draft => ({
  questionText: q.questionText, section: q.section, sectionOrder: q.sectionOrder, displayOrder: q.displayOrder,
  responseType: q.responseType, responseOptionsText: q.responseOptions.join('\n'),
  isRequired: q.isRequired, helpText: q.helpText, enabled: q.enabled, requiresPhoto: q.requiresPhoto, requiresNote: q.requiresNote,
});

// Merge an edited Draft onto a (possibly partial) base Question — used for
// optimistic list updates so the builder reflects a save immediately, without
// waiting on HubSpot's search index to catch up. Fields the builder doesn't
// expose (noteRequiredOnValues, assignedTo, etc.) are preserved from the base.
const applyDraft = (base: Partial<Question>, d: Draft): Question => ({
  hubspotRecordId: base.hubspotRecordId || '',
  questionIdExternal: base.questionIdExternal || '',
  questionText: d.questionText,
  section: d.section,
  sectionOrder: d.sectionOrder,
  displayOrder: d.displayOrder,
  responseType: d.responseType,
  responseOptions: toOptions(d.responseOptionsText),
  defaultValue: base.defaultValue || '',
  noteRequiredOnValues: base.noteRequiredOnValues || [],
  hasAssignedTo: base.hasAssignedTo ?? false,
  assignedToOptions: base.assignedToOptions || [],
  repeatsPerRoomType: base.repeatsPerRoomType || '',
  appliesToTemplates: base.appliesToTemplates || [],
  isRequired: d.isRequired,
  helpText: d.helpText,
  enabled: d.enabled,
  requiresPhoto: d.requiresPhoto,
  requiresNote: d.requiresNote,
});

const ADD_NEW = '__add_new_section__';

function QuestionEditor({ initial, onSave, onCancel, busy, knownSections = [] }: {
  initial: Draft; onSave: (d: Draft) => void; onCancel: () => void; busy: boolean; knownSections?: string[];
}) {
  const [d, setD] = useState<Draft>(initial);
  // Section options = the standard list + any sections already used on this
  // template (so existing ones are selectable, not just re-typable).
  const allSections = useMemo(
    () => Array.from(new Set([...STANDARD_SECTIONS, ...knownSections])),
    [knownSections],
  );
  // A value not in the known list starts in free-text mode.
  const [customSection, setCustomSection] = useState(() => !!initial.section && !allSections.includes(initial.section));
  const typeMeta = RESPONSE_TYPES.find((t) => t.value === d.responseType);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));

  const sectionOptions = [
    ...allSections.map((s) => ({ value: s, label: s })),
    { value: ADD_NEW, label: '➕ Add new section…' },
  ];

  return (
    <div className="rounded-lg border border-brand/40 bg-brand/5 p-3 space-y-2.5">
      <textarea value={d.questionText} onChange={(e) => set({ questionText: e.target.value })} rows={2}
        placeholder="Question text" className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm" />

      {/* Section: dropdown of standard sections, with "Add new" → free text. */}
      <div>
        <div className="text-[11px] font-heading font-semibold text-gray-500 mb-0.5">Section</div>
        {customSection ? (
          <div className="flex items-center gap-2">
            <input autoFocus value={d.section} onChange={(e) => set({ section: e.target.value })}
              placeholder="New section name" className="focus-brand flex-1 border border-gray-300 rounded-lg p-2 text-sm" />
            <button type="button" onClick={() => { setCustomSection(false); set({ section: '' }); }}
              className="text-xs font-heading font-semibold text-gray-600 shrink-0">Choose existing</button>
          </div>
        ) : (
          <Combobox
            compact filled
            deferKeyboard
            options={sectionOptions}
            value={d.section}
            placeholder="Select a section"
            onChange={(v) => { if (v === ADD_NEW) { setCustomSection(true); set({ section: '' }); } else { set({ section: v }); } }}
          />
        )}
      </div>

      {/* Answer type: the app-standard dropdown (not the OS picker). */}
      <div>
        <div className="text-[11px] font-heading font-semibold text-gray-500 mb-0.5">Answer type</div>
        <Combobox
          compact filled
          options={RESPONSE_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          value={d.responseType}
          onChange={(v) => set({ responseType: v as ResponseType })}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] font-heading font-semibold text-gray-500">Section order
          <input type="number" inputMode="numeric" min={0} value={d.sectionOrder === 0 ? '' : d.sectionOrder}
            onChange={(e) => { const n = parseInt(e.target.value, 10); set({ sectionOrder: Number.isFinite(n) && n >= 0 ? n : 0 }); }}
            className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm mt-0.5" />
        </label>
        <label className="text-[11px] font-heading font-semibold text-gray-500">Display order
          <input type="number" inputMode="numeric" min={0} value={d.displayOrder === 0 ? '' : d.displayOrder}
            onChange={(e) => { const n = parseInt(e.target.value, 10); set({ displayOrder: Number.isFinite(n) && n >= 0 ? n : 0 }); }}
            className="focus-brand w-full border border-gray-300 rounded-lg p-2 text-sm mt-0.5" />
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
      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" checked={d.isRequired} onChange={(e) => set({ isRequired: e.target.checked })} /> Required</label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" checked={d.requiresPhoto} onChange={(e) => set({ requiresPhoto: e.target.checked })} /> Require photo</label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700"><input type="checkbox" checked={d.requiresNote} onChange={(e) => set({ requiresNote: e.target.checked })} /> Require note</label>
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
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [template, setTemplate] = useState<string>('');
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

  async function loadTemplates(selectId?: string) {
    try {
      const r = await fetch('/api/admin/templates', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load templates'); return; }
      const list: TemplateInfo[] = d.templates || [];
      setTemplates(list);
      setTemplate((cur) => selectId || cur || (list[0]?.id ?? ''));
    } catch (e: any) { setError(String(e?.message || e)); }
  }
  useEffect(() => { if (isAdmin) loadTemplates(); /* eslint-disable-next-line */ }, [isAdmin]);

  async function newTemplate() {
    const label = window.prompt('New template name (e.g. “Move-Out Walkthrough”):')?.trim();
    if (!label) return;
    setBusy(true);
    try {
      const r = await fetch('/api/admin/templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Create failed'); return; }
      setError(null);
      await loadTemplates(d.template?.id);
    } finally { setBusy(false); }
  }

  async function removeTemplate() {
    const t = templates.find((x) => x.id === template);
    if (!t || !t.custom) return;
    if (!confirm(`Remove the “${t.label}” template? Its questions stay in HubSpot (archive them first if you want them gone).`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/templates/${encodeURIComponent(template)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Remove failed'); return; }
      setError(null);
      setTemplate('');
      await loadTemplates();
    } finally { setBusy(false); }
  }

  async function load() {
    setQuestions(null);
    if (!template) return;
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
    // Sort by section then display order so add/edit/reorder reflect immediately.
    const sorted = [...(questions || [])].sort((a, b) =>
      (a.sectionOrder - b.sectionOrder) || (a.displayOrder - b.displayOrder));
    const m = new Map<string, Question[]>();
    for (const q of sorted) { const k = q.section || '(no section)'; (m.get(k) || m.set(k, []).get(k)!).push(q); }
    return Array.from(m.entries());
  }, [questions]);

  // Sections already in use on THIS template — offered in the Section dropdown
  // alongside the standard list so any existing section (e.g. "Curb Appeal /
  // Amenities") is selectable without retyping it.
  const knownSections = useMemo(
    () => Array.from(new Set((questions || []).map((q) => (q.section || '').trim()).filter(Boolean))),
    [questions],
  );

  async function saveEdit(id: string, d: Draft) {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/questions/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...d, responseOptions: toOptions(d.responseOptionsText) }),
      });
      const dd = await r.json();
      if (!r.ok) { setError(dd.error || 'Save failed'); return; }
      // Optimistically update the list (HubSpot's search index lags a few
      // seconds after a write, so re-fetching here would show stale data).
      setQuestions((cur) => (cur || []).map((q) => q.hubspotRecordId === id ? applyDraft(q, d) : q));
      setEditingId(null); setError(null);
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
      // Append the new question immediately (search-index lag would otherwise
      // hide it on an immediate re-fetch).
      const newQ = applyDraft(
        { hubspotRecordId: dd.id, questionIdExternal: dd.questionIdExternal, appliesToTemplates: [template] },
        d,
      );
      setQuestions((cur) => [...(cur || []), newQ]);
      setAdding(false); setError(null);
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
      setQuestions((cur) => (cur || []).map((x) => x.hubspotRecordId === q.hubspotRecordId ? { ...x, enabled: !q.enabled } : x));
      setError(null);
    } finally { setBusy(false); }
  }

  async function remove(q: Question) {
    if (!confirm(`Remove “${q.questionText.slice(0, 60)}”? It will be archived in HubSpot.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/questions/${q.hubspotRecordId}`, { method: 'DELETE' });
      const dd = await r.json();
      if (!r.ok) { setError(dd.error || 'Remove failed'); return; }
      setQuestions((cur) => (cur || []).filter((x) => x.hubspotRecordId !== q.hubspotRecordId));
      setError(null);
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
          <Link href="/" className="text-xs font-heading font-semibold text-white/90 hover:text-white shrink-0 inline-flex items-center gap-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M11 18l-6-6 6-6" /></svg> Inspections</Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-5">
        <div className="flex items-end justify-between gap-2 mb-1">
          <label className="block text-xs font-heading font-semibold text-gray-500">Template</label>
          <div className="flex items-center gap-2">
            {templates.find((t) => t.id === template)?.custom && (
              <button type="button" onClick={removeTemplate} disabled={busy} className="text-xs font-heading font-semibold text-red-700 hover:underline">Remove template</button>
            )}
            <button type="button" onClick={newTemplate} disabled={busy} className="text-xs font-heading font-semibold text-brand hover:underline">+ New template</button>
          </div>
        </div>
        <div className="mb-3">
          <Combobox
            filled
            options={templates.map((t) => ({ value: t.id, label: `${t.label}${t.custom ? ' (custom)' : ''}` }))}
            value={template}
            placeholder="Select a template"
            onChange={(v) => { setEditingId(null); setAdding(false); setTemplate(v); }}
          />
        </div>
        <p className="text-[12px] text-gray-500 mb-4">Scope Rate Card and Turn Re-Inspect QC are locked and not editable here. New templates and question changes sync to HubSpot and apply to new inspections immediately.</p>

        {error && <div className="mb-4 p-3 bg-rose-50 border border-rose-300 rounded text-sm text-rose-800">{error}</div>}

        <div className="flex justify-end mb-3">
          <button type="button" onClick={() => { setAdding(true); setEditingId(null); }} disabled={adding}
            className="h-9 px-4 rounded-lg bg-brand text-white font-heading font-bold text-sm disabled:bg-gray-300">+ Add question</button>
        </div>

        {adding && (
          <div className="mb-4">
            <QuestionEditor initial={blankDraft()} busy={busy} knownSections={knownSections}
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
                        <QuestionEditor initial={fromQuestion(q)} busy={busy} knownSections={knownSections}
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
