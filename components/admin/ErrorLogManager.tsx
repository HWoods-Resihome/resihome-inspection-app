/**
 * Error Log (admin · /admin/flows).
 *
 * A near-real-time view of app failures captured across the platform — login
 * failures, inspection-load failures ("could not load / not found"), inspection-
 * start failures, write-denied ("you can only edit your own"), sync failures, and
 * client crashes. Each row shows WHEN, WHO (email), the KIND, the inspection
 * TEMPLATE + id, the APP VERSION, and the causing message. Filter by kind / email
 * / free text. Auto-refreshes every 15s while open. Read-only.
 * Backend: /api/admin/error-log (lib/errorLog, Vercel Blob).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface ErrEvent {
  ts: string;
  kind: string;
  message: string;
  email?: string;
  inspectionId?: string;
  template?: string;
  status?: string;
  appVersion?: string;
  url?: string;
  online?: boolean;
  source?: string;
  meta?: Record<string, unknown>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>;
}

// Kind → label + color chip. Unknown kinds fall back to a neutral gray.
const KIND_META: Record<string, { label: string; cls: string }> = {
  login: { label: 'Login', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  inspection_load: { label: 'Load', cls: 'bg-rose-100 text-rose-800 border-rose-300' },
  inspection_start: { label: 'Start', cls: 'bg-orange-100 text-orange-800 border-orange-300' },
  write_denied: { label: 'Write denied', cls: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300' },
  sync: { label: 'Sync', cls: 'bg-sky-100 text-sky-800 border-sky-300' },
  client: { label: 'Client', cls: 'bg-slate-100 text-slate-700 border-slate-300' },
  server: { label: 'Server', cls: 'bg-red-100 text-red-800 border-red-300' },
};
function kindMeta(k: string) { return KIND_META[k] || { label: k || 'other', cls: 'bg-gray-100 text-gray-700 border-gray-300' }; }

const TEMPLATE_SHORT: Record<string, string> = {
  leasing_agent_1099_property_inspection: '1099 Leasing',
  pm_scope_rate_card: 'Scope',
  pm_turn_reinspect_qc: 'QC Re-Inspect',
  pm_community_inspection: 'Community',
  pm_vacancy_occupancy_check: 'Vacancy',
  qc_new_construction_rrqc: 'RRQC',
};

function fmt(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return ts; }
}

export function ErrorLogManager() {
  const [sectionOpen, setSectionOpen] = useState(false);
  const [events, setEvents] = useState<ErrEvent[] | null>(null);
  const [kinds, setKinds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState('');
  const [q, setQ] = useState('');
  const [lastLoadedAt, setLastLoadedAt] = useState<string>('');
  // Per-row repair state: inspectionId -> 'busy' | 'done' | error string.
  const [repair, setRepair] = useState<Record<string, string>>({});
  const qRef = useRef(q);
  qRef.current = q;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '300');
      if (kindFilter) params.set('kind', kindFilter);
      if (qRef.current.trim()) params.set('q', qRef.current.trim());
      const r = await fetch(`/api/admin/error-log?${params.toString()}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); return; }
      setEvents(d.events || []);
      if (Array.isArray(d.kinds) && d.kinds.length) setKinds(d.kinds);
      setLastLoadedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setLoading(false); }
  }, [kindFilter]);

  // Reassign a walk's inspector back to the denied agent (recovers a walk whose
  // inspector was clobbered by the old owner-sync). Only offered on write_denied
  // rows where we know both the intended agent (row email) and the inspection id.
  const repairRow = useCallback(async (inspectionId: string, inspectorEmail: string) => {
    if (!inspectionId || !inspectorEmail) return;
    if (!window.confirm(`Reassign inspection ${inspectionId} back to ${inspectorEmail}?`)) return;
    setRepair((s) => ({ ...s, [inspectionId]: 'busy' }));
    try {
      const r = await fetch('/api/admin/repair-inspector', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ inspectionId, inspectorEmail }] }),
      });
      const d = await r.json();
      if (!r.ok) { setRepair((s) => ({ ...s, [inspectionId]: d.error || 'failed' })); return; }
      const ok = Array.isArray(d.results) && d.results[0]?.ok;
      setRepair((s) => ({ ...s, [inspectionId]: ok ? 'done' : (d.results?.[0]?.note || 'failed') }));
      void load();
    } catch (e: any) {
      setRepair((s) => ({ ...s, [inspectionId]: String(e?.message || e) }));
    }
  }, [load]);

  // Initial load on open + when the kind filter changes.
  useEffect(() => { if (sectionOpen) void load(); }, [sectionOpen, load]);

  // Auto-refresh every 15s while the section is open (near real-time).
  useEffect(() => {
    if (!sectionOpen) return;
    const t = setInterval(() => { void load(); }, 15000);
    return () => clearInterval(t);
  }, [sectionOpen, load]);

  return (
    <section className="mt-5 border border-gray-200 rounded-xl bg-white overflow-hidden">
      <button type="button" onClick={() => setSectionOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 p-4 text-left">
        <div>
          <h2 className="font-heading font-bold text-base text-ink flex items-center gap-2">
            Error Log
            {events && events.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 rounded-full bg-rose-100 text-rose-700 text-[11px] font-bold">{events.length}</span>
            )}
          </h2>
          <p className="text-[13px] text-gray-600 mt-1 leading-relaxed">
            App failures across all users — login, inspection load/start, write-denied, sync, and crashes. Auto-refreshes every 15s.
          </p>
        </div>
        <span className="text-gray-400"><Chevron open={sectionOpen} /></span>
      </button>

      {sectionOpen && (
        <div className="px-4 pb-4">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <button type="button" onClick={() => setKindFilter('')}
              className={`px-2.5 h-7 rounded-full border text-[12px] font-heading font-semibold ${kindFilter === '' ? 'bg-ink text-white border-ink' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>All</button>
            {kinds.map((k) => {
              const m = kindMeta(k);
              const active = kindFilter === k;
              return (
                <button key={k} type="button" onClick={() => setKindFilter(active ? '' : k)}
                  className={`px-2.5 h-7 rounded-full border text-[12px] font-heading font-semibold ${active ? 'bg-ink text-white border-ink' : `${m.cls} hover:opacity-80`}`}>{m.label}</button>
              );
            })}
            <div className="flex-1" />
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
              placeholder="Search email, message, id…"
              className="focus-brand h-8 w-56 max-w-full border border-gray-300 rounded-lg px-2.5 text-[13px]" />
            <button type="button" onClick={() => void load()} disabled={loading}
              className="h-8 px-3 rounded-lg bg-brand text-white font-heading font-semibold text-[12px] hover:opacity-90 disabled:bg-gray-300">
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {error && <div className="mb-3 p-3 bg-rose-50 border border-rose-300 rounded text-sm text-rose-800">{error}</div>}

          {events && events.length === 0 && !error && (
            <div className="p-6 text-center text-sm text-gray-500 bg-gray-50 rounded-lg border border-gray-200">
              No errors recorded{kindFilter || q ? ' for this filter' : ' yet'}. 🎉
            </div>
          )}

          {events && events.length > 0 && (
            <div className="overflow-x-auto -mx-1 px-1">
              <table className="w-full text-[12.5px] border-collapse">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-3 font-heading font-semibold whitespace-nowrap">When</th>
                    <th className="py-2 pr-3 font-heading font-semibold">Kind</th>
                    <th className="py-2 pr-3 font-heading font-semibold">User</th>
                    <th className="py-2 pr-3 font-heading font-semibold">Template</th>
                    <th className="py-2 pr-3 font-heading font-semibold">Issue</th>
                    <th className="py-2 pr-3 font-heading font-semibold whitespace-nowrap">Ver</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, i) => {
                    const m = kindMeta(e.kind);
                    const tmpl = e.template ? (TEMPLATE_SHORT[e.template] || e.template) : '';
                    const stored = e.meta && typeof (e.meta as any).storedInspectorEmail === 'string' ? String((e.meta as any).storedInspectorEmail) : '';
                    return (
                      <tr key={`${e.ts}-${i}`} className="border-b border-gray-100 align-top">
                        <td className="py-2 pr-3 whitespace-nowrap text-gray-600">{fmt(e.ts)}</td>
                        <td className="py-2 pr-3"><span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${m.cls}`}>{m.label}</span></td>
                        <td className="py-2 pr-3 text-gray-700 break-all">{e.email || <span className="text-gray-400">—</span>}</td>
                        <td className="py-2 pr-3 text-gray-700 whitespace-nowrap">{tmpl || <span className="text-gray-400">—</span>}</td>
                        <td className="py-2 pr-3 text-gray-800">
                          <div>{e.message}</div>
                          {(e.inspectionId || stored) && (
                            <div className="mt-0.5 text-[11px] text-gray-500">
                              {e.inspectionId && <a href={`/inspection/${e.inspectionId}`} className="text-brand underline break-all" target="_blank" rel="noreferrer">{e.inspectionId}</a>}
                              {stored && <span className="ml-2">stored inspector: <span className="font-mono">{stored}</span></span>}
                            </div>
                          )}
                          {/* One-click recovery for a walk whose inspector was clobbered: reassign
                              it back to the denied agent (this row's email). */}
                          {e.kind === 'write_denied' && e.inspectionId && e.email && (
                            <div className="mt-1">
                              {repair[e.inspectionId] === 'done' ? (
                                <span className="text-[11px] text-emerald-600 font-semibold">✓ Reassigned to {e.email}</span>
                              ) : repair[e.inspectionId] === 'busy' ? (
                                <span className="text-[11px] text-gray-400">Reassigning…</span>
                              ) : (
                                <button type="button" onClick={() => void repairRow(e.inspectionId!, e.email!)}
                                  className="text-[11px] font-heading font-semibold text-brand underline hover:opacity-80">
                                  Reassign to {e.email}
                                </button>
                              )}
                              {repair[e.inspectionId] && !['done', 'busy'].includes(repair[e.inspectionId]) && (
                                <span className="ml-2 text-[11px] text-rose-600">{repair[e.inspectionId]}</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap text-gray-400 font-mono text-[11px]">{e.appVersion || ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {lastLoadedAt && (
            <p className="mt-3 text-[11px] text-gray-400">Last updated {lastLoadedAt} · showing newest first{events ? ` · ${events.length} shown` : ''}.</p>
          )}
        </div>
      )}
    </section>
  );
}
