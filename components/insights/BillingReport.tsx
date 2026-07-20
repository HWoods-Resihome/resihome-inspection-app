/**
 * components/insights/BillingReport.tsx — the billing report at the TOP of each
 * Insights tab. Filterable table (region / portfolio / inspector-or-vendor /
 * completed-date range with relative presets), real .xlsx export, and a
 * schedule manager for emailed reports (daily/weekly/monthly at an ET hour,
 * with a "Send test" button). Dark theme to match the Insights dashboard.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

type Obj = 'inspections' | 'services';
type Row = (string | number)[];
interface Facets { regions: string[]; portfolios: string[]; people: string[]; types: string[] }

const RANGES: { value: string; label: string }[] = [
  { value: 'last_7_days', label: 'Last 7 days' }, { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'this_week', label: 'This week' }, { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' }, { value: 'last_month', label: 'Last month' },
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_year', label: 'This year' }, { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom…' },
];

// Client-side resolve of a relative preset → { from, to } (browser-local date;
// the scheduled cron resolves in ET precisely). 'custom'/'all' handled by caller.
function resolveRange(range: string): { from?: string; to?: string } {
  const now = new Date();
  const d = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = d(now);
  const shift = (n: number) => { const x = new Date(now); x.setDate(x.getDate() + n); return d(x); };
  const dow = now.getDay();
  switch (range) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: shift(-1), to: shift(-1) };
    case 'last_7_days': return { from: shift(-6), to: today };
    case 'last_30_days': return { from: shift(-29), to: today };
    case 'this_week': return { from: shift(-dow), to: today };
    case 'last_week': return { from: shift(-dow - 7), to: shift(-dow - 1) };
    case 'this_month': return { from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, to: today };
    case 'last_month': { const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(); const m = now.getMonth() === 0 ? 12 : now.getMonth(); const last = new Date(y, m, 0).getDate(); return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` }; }
    case 'this_year': return { from: `${now.getFullYear()}-01-01`, to: today };
    default: return {};
  }
}

const CTRL = 'text-[13px] px-2.5 py-1.5 rounded-lg bg-[#232329] border border-white/10 text-[#f4f4f5] focus:outline-none focus:border-[#ff0060]';

/** Dark multi-select dropdown (checklist). */
function MultiPick({ label, options, selected, onChange }: { label: string; options: string[]; selected: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={`${CTRL} inline-flex items-center gap-1.5 ${selected.length ? 'border-[#ff0060] text-[#ff0060]' : ''}`}>
        {label}{selected.length ? ` (${selected.length})` : ''}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (<>
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div className="absolute left-0 mt-1 z-50 w-64 max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-[#18181c] shadow-xl py-1">
          {selected.length > 0 && <button type="button" onClick={() => onChange([])} className="w-full text-left px-3 py-1.5 text-[12px] text-[#a1a1aa] hover:bg-white/5">Clear all</button>}
          {options.length === 0 && <div className="px-3 py-2 text-[12px] text-[#71717a]">No options</div>}
          {options.map((o) => {
            const on = selected.includes(o);
            return (
              <button key={o} type="button" onClick={() => toggle(o)} className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left hover:bg-white/5">
                <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] font-bold ${on ? 'bg-[#ff0060] border-[#ff0060] text-white' : 'border-white/20 text-transparent'}`}>✓</span>
                <span className="text-[#f4f4f5] truncate">{o}</span>
              </button>
            );
          })}
        </div>
      </>)}
    </div>
  );
}

export function BillingReport({ object }: { object: Obj }) {
  const personLabel = object === 'services' ? 'Vendor' : 'Inspector';
  const typeLabel = object === 'services' ? 'Service Type' : 'Inspection Type';
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [facets, setFacets] = useState<Facets>({ regions: [], portfolios: [], people: [], types: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [regions, setRegions] = useState<string[]>([]);
  const [portfolios, setPortfolios] = useState<string[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [range, setRange] = useState('last_7_days');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);

  const resolved = useMemo(() => {
    if (range === 'custom') return { from: customFrom || undefined, to: customTo || undefined };
    return resolveRange(range);
  }, [range, customFrom, customTo]);

  // DRAFT (the controls above) vs APPLIED (what the table/export/schedule use).
  // Selections stage in the draft and only take effect on "Apply", so the
  // dropdowns never re-query / collapse while you're picking.
  type Applied = { regions: string[]; portfolios: string[]; inspectors: string[]; types: string[]; from?: string; to?: string };
  const draftApplied: Applied = useMemo(() => ({ regions, portfolios, inspectors: people, types, from: resolved.from, to: resolved.to }), [regions, portfolios, people, types, resolved]);
  const [applied, setApplied] = useState<Applied>(() => ({ regions: [], portfolios: [], inspectors: [], types: [], ...resolveRange('last_7_days') }));
  const dirty = useMemo(() => JSON.stringify(draftApplied) !== JSON.stringify(applied), [draftApplied, applied]);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ object });
    if (applied.regions.length) p.set('regions', applied.regions.join(','));
    if (applied.portfolios.length) p.set('portfolios', applied.portfolios.join(','));
    if (applied.inspectors.length) p.set('inspectors', applied.inspectors.join(','));
    if (applied.types.length) p.set('types', applied.types.join(','));
    if (applied.from) p.set('from', applied.from);
    if (applied.to) p.set('to', applied.to);
    return p.toString();
  }, [object, applied]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/insights/billing?${qs}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setColumns(d.columns || []); setRows(d.rows?.length ? d.rows.map((row: any) => Array.isArray(row) ? row : rowFromObj(row)) : cellsFrom(d.rows));
      if (d.facets) setFacets(d.facets);
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setLoading(false); }
  }, [qs]);
  useEffect(() => { void load(); }, [load]);

  async function exportXlsx() {
    setExporting(true);
    try {
      const r = await fetch(`/api/insights/billing?${qs}&format=xlsx`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${object === 'services' ? 'service' : 'inspection'}-billing-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    finally { setExporting(false); }
  }

  const money = (v: string | number) => (typeof v === 'number' ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : v);
  const amountCols = useMemo(() => new Set(columns.map((c, i) => (/amount/i.test(c) ? i : -1)).filter((i) => i >= 0)), [columns]);

  return (
    <section className="bg-[#18181c] border border-white/10 rounded-2xl p-4 mb-5">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="font-heading font-bold text-[15px] text-[#f4f4f5]">{object === 'services' ? 'Services' : 'Inspections'} Billing</h2>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void exportXlsx()} disabled={exporting}
            className="text-[13px] font-heading font-bold px-3 py-1.5 rounded-lg bg-[#ff0060] text-white hover:opacity-90 disabled:opacity-60">
            {exporting ? 'Exporting…' : 'Export Excel'}
          </button>
          <button type="button" onClick={() => setSchedOpen(true)}
            className="text-[13px] font-heading font-semibold px-3 py-1.5 rounded-lg bg-[#232329] border border-white/10 text-[#f4f4f5] hover:border-[#ff0060]">
            Schedule Email
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <MultiPick label="Region" options={facets.regions} selected={regions} onChange={setRegions} />
        <MultiPick label="Portfolio" options={facets.portfolios} selected={portfolios} onChange={setPortfolios} />
        <MultiPick label={personLabel} options={facets.people} selected={people} onChange={setPeople} />
        <MultiPick label={typeLabel} options={facets.types} selected={types} onChange={setTypes} />
        <select value={range} onChange={(e) => setRange(e.target.value)} className={CTRL} aria-label="Completed date range">
          {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        {range === 'custom' && (
          <>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className={CTRL} aria-label="From" />
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className={CTRL} aria-label="To" />
          </>
        )}
        <button type="button" onClick={() => setApplied(draftApplied)} disabled={!dirty}
          className={`text-[13px] font-heading font-bold px-3 py-1.5 rounded-lg ${dirty ? 'bg-[#ff0060] text-white hover:opacity-90' : 'bg-[#232329] border border-white/10 text-[#71717a]'}`}>
          Apply{dirty ? ' •' : ''}
        </button>
        {(regions.length || portfolios.length || people.length || types.length) > 0 && (
          <button type="button" onClick={() => { setRegions([]); setPortfolios([]); setPeople([]); setTypes([]); }} className="text-[12px] text-[#a1a1aa] hover:text-[#f4f4f5] underline">Reset filters</button>
        )}
      </div>

      {error && <div className="mb-2 px-3 py-2 rounded-lg bg-[#ff0060]/10 border border-[#ff0060]/40 text-[13px] text-[#ff0060]">{error}</div>}
      <div className="text-[12px] text-[#71717a] mb-1.5">{loading ? 'Loading…' : `${rows.length} row${rows.length === 1 ? '' : 's'}`}{applied.from || applied.to ? ` · completed ${applied.from || '…'} → ${applied.to || '…'}` : ' · all time'}{dirty ? ' · filters changed — hit Apply' : ''}</div>

      <div className="overflow-x-auto rounded-lg border border-white/10 max-h-[460px] overflow-y-auto">
        <table className="w-full text-[12px] whitespace-nowrap">
          <thead className="sticky top-0 bg-[#232329]">
            <tr>{columns.map((c) => <th key={c} className="text-left font-heading font-semibold text-[#a1a1aa] px-3 py-2 border-b border-white/10">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-white/5">
                {row.map((cell, j) => <td key={j} className={`px-3 py-1.5 border-b border-white/5 text-[#e4e4e7] ${amountCols.has(j) ? 'tabular-nums text-right' : ''}`}>{amountCols.has(j) ? money(cell) : String(cell ?? '')}</td>)}
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={columns.length || 1} className="px-3 py-8 text-center text-[#71717a]">No rows for these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      {schedOpen && (
        <ScheduleManager object={object} personLabel={personLabel} facets={facets}
          current={{ regions: applied.regions, portfolios: applied.portfolios, inspectors: applied.inspectors, types: applied.types, range: range === 'custom' ? 'last_7_days' : range }}
          onClose={() => setSchedOpen(false)} />
      )}
    </section>
  );
}

// The API returns rows already as arrays of cells; these guards keep older/edge
// shapes from throwing.
function cellsFrom(v: any): Row[] { return Array.isArray(v) ? v.map((r) => (Array.isArray(r) ? r : rowFromObj(r))) : []; }
function rowFromObj(o: any): Row {
  return [o.externalId, o.entityId, o.region, o.portfolio, o.fullAddress, o.typeLabel, o.personName, o.brokerCode, o.completedDate, o.vendorAmount, o.clientAmount];
}

// ── Schedule manager modal ───────────────────────────────────────────────────
interface Sched {
  id: string; name: string; object: Obj; recipients: string[]; regions: string[]; portfolios: string[]; inspectors: string[]; types: string[];
  range: string; cadence: 'daily' | 'weekly' | 'monthly'; hourET: number; dayOfWeek?: number; dayOfMonth?: number; enabled: boolean; lastRunAt?: string;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function hourLabel(h: number) { const am = h < 12; const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}:00 ${am ? 'AM' : 'PM'} ET`; }

function ScheduleManager({ object, personLabel, facets, current, onClose }: {
  object: Obj; personLabel: string; facets: Facets;
  current: { regions: string[]; portfolios: string[]; inspectors: string[]; types: string[]; range: string };
  onClose: () => void;
}) {
  const [list, setList] = useState<Sched[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // New/edit form.
  const [name, setName] = useState(`${object === 'services' ? 'Services' : 'Inspections'} Billing`);
  const [recipients, setRecipients] = useState('');
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [hourET, setHourET] = useState(8);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [range, setRange] = useState(current.range || 'last_7_days');
  // When editing an existing schedule: its id + the filters it carries (so an
  // edit preserves the schedule's OWN filters rather than the page's current ones).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFilters, setEditFilters] = useState<{ regions: string[]; portfolios: string[]; inspectors: string[]; types: string[] } | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch('/api/insights/report-schedules', { cache: 'no-store' }); const d = await r.json(); setList((d.schedules || []).filter((s: Sched) => s.object === object)); } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [object]);
  useEffect(() => { void loadList(); }, [loadList]);

  const resetForm = () => {
    setEditingId(null); setEditFilters(null); setRecipients('');
    setName(`${object === 'services' ? 'Services' : 'Inspections'} Billing`);
    setCadence('weekly'); setHourET(8); setDayOfWeek(1); setDayOfMonth(1); setRange(current.range || 'last_7_days');
  };
  const startEdit = (s: Sched) => {
    setEditingId(s.id); setEditFilters({ regions: s.regions || [], portfolios: s.portfolios || [], inspectors: s.inspectors || [], types: s.types || [] });
    setName(s.name); setRecipients((s.recipients || []).join(', ')); setCadence(s.cadence); setHourET(s.hourET);
    setDayOfWeek(s.dayOfWeek ?? 1); setDayOfMonth(s.dayOfMonth ?? 1); setRange(s.range);
    setMsg(null);
  };

  const payload = () => {
    const f = editingId && editFilters ? editFilters : { regions: current.regions, portfolios: current.portfolios, inspectors: current.inspectors, types: current.types };
    return {
      object, name: name.trim(),
      recipients: recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
      regions: f.regions, portfolios: f.portfolios, inspectors: f.inspectors, types: f.types,
      range, cadence, hourET, dayOfWeek, dayOfMonth, enabled: true,
      ...(editingId ? { id: editingId } : {}),
    };
  };

  async function saveNew() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/insights/report-schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const wasEdit = !!editingId; resetForm(); await loadList(); setMsg(wasEdit ? 'Schedule updated.' : 'Schedule saved.');
    } catch (e: any) { setMsg(`Could not save: ${e?.message || e}`); }
    finally { setBusy(false); }
  }
  async function sendTest() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/insights/report-schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test', ...payload() }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setMsg(`Test sent (${d.rows} rows).`);
    } catch (e: any) { setMsg(`Test failed: ${e?.message || e}`); }
    finally { setBusy(false); }
  }
  async function testSaved(s: Sched) {
    setBusy(true); setMsg(null);
    try { const r = await fetch('/api/insights/report-schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test', id: s.id }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); setMsg(`Test sent to ${s.recipients.length} recipient(s).`); }
    catch (e: any) { setMsg(`Test failed: ${e?.message || e}`); }
    finally { setBusy(false); }
  }
  async function remove(s: Sched) {
    setBusy(true);
    try { await fetch('/api/insights/report-schedules', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }) }); await loadList(); }
    finally { setBusy(false); }
  }

  const cadenceDesc = (s: Sched) => s.cadence === 'daily' ? `Daily · ${hourLabel(s.hourET)}` : s.cadence === 'weekly' ? `Weekly · ${DOW[s.dayOfWeek ?? 1]} · ${hourLabel(s.hourET)}` : `Monthly · day ${s.dayOfMonth ?? 1} · ${hourLabel(s.hourET)}`;

  return (
    <div className="fixed inset-0 z-[2000] bg-black/60 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-[#18181c] border border-white/10 rounded-2xl w-full max-w-lg my-8 text-[#f4f4f5]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h3 className="font-heading font-bold text-[15px]">Schedule Emailed Report</h3>
          <button type="button" onClick={onClose} className="text-[#a1a1aa] text-2xl leading-none px-1">×</button>
        </div>
        <div className="p-4 space-y-3">
          {(() => { const f = editingId && editFilters ? editFilters : current; const summ = [f.regions.length ? `${f.regions.length} region(s)` : '', f.portfolios.length ? `${f.portfolios.length} portfolio(s)` : '', f.inspectors.length ? `${f.inspectors.length} ${personLabel.toLowerCase()}(s)` : '', f.types.length ? `${f.types.length} type(s)` : ''].filter(Boolean).join(', ') || 'no filters'; return (
            <p className="text-[12px] text-[#a1a1aa]">{editingId ? 'Editing this schedule. It keeps its own saved filters' : 'Emails the billing Excel using the filters currently applied above'} ({summ}). Sends from the ResiWalk mailbox.</p>
          ); })()}

          <label className="block text-[12px] font-heading font-semibold text-[#a1a1aa]">Report name
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${CTRL} w-full mt-1`} />
          </label>
          <label className="block text-[12px] font-heading font-semibold text-[#a1a1aa]">Recipient emails (comma-separated)
            <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="ops@resihome.com, billing@resihome.com" className={`${CTRL} w-full mt-1`} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[12px] font-heading font-semibold text-[#a1a1aa]">Completed window
              <select value={range} onChange={(e) => setRange(e.target.value)} className={`${CTRL} w-full mt-1`}>
                {RANGES.filter((r) => r.value !== 'custom').map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>
            <label className="block text-[12px] font-heading font-semibold text-[#a1a1aa]">Cadence
              <select value={cadence} onChange={(e) => setCadence(e.target.value as any)} className={`${CTRL} w-full mt-1`}>
                <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="block text-[12px] font-heading font-semibold text-[#a1a1aa]">Send hour (ET)
              <select value={hourET} onChange={(e) => setHourET(Number(e.target.value))} className={`${CTRL} w-full mt-1`}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </label>
            {cadence === 'weekly' && (
              <label className="block text-[12px] font-heading font-semibold text-[#a1a1aa]">Day of week
                <select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))} className={`${CTRL} w-full mt-1`}>
                  {DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </label>
            )}
            {cadence === 'monthly' && (
              <label className="block text-[12px] font-heading font-semibold text-[#a1a1aa]">Day of month
                <select value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} className={`${CTRL} w-full mt-1`}>
                  {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                </select>
              </label>
            )}
          </div>
          {msg && <div className="text-[12px] text-[#73E3DF]">{msg}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={() => void saveNew()} disabled={busy} className="text-[13px] font-heading font-bold px-4 py-2 rounded-lg bg-[#ff0060] text-white disabled:opacity-60">{editingId ? 'Update schedule' : 'Save schedule'}</button>
            <button type="button" onClick={() => void sendTest()} disabled={busy} className="text-[13px] font-heading font-semibold px-4 py-2 rounded-lg bg-[#232329] border border-white/10 disabled:opacity-60">Send test now</button>
            {editingId && <button type="button" onClick={resetForm} disabled={busy} className="text-[13px] font-heading font-semibold px-4 py-2 rounded-lg text-[#a1a1aa] hover:text-[#f4f4f5]">Cancel edit</button>}
          </div>

          <div className="border-t border-white/10 pt-3">
            <div className="text-[12px] font-heading font-semibold text-[#a1a1aa] mb-1.5">Existing schedules</div>
            {loading ? <div className="text-[12px] text-[#71717a]">Loading…</div> : list.length === 0 ? <div className="text-[12px] text-[#71717a]">None yet.</div> : (
              <div className="space-y-2">
                {list.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 bg-[#232329] border border-white/10 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[13px] font-heading font-semibold truncate">{s.name}</div>
                      <div className="text-[11px] text-[#a1a1aa] truncate">{cadenceDesc(s)} · {s.recipients.length} recipient(s)</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" onClick={() => startEdit(s)} disabled={busy} className="text-[11px] font-heading font-semibold text-[#f4f4f5] hover:underline">Edit</button>
                      <button type="button" onClick={() => void testSaved(s)} disabled={busy} className="text-[11px] font-heading font-semibold text-[#73E3DF] hover:underline">Test</button>
                      <button type="button" onClick={() => void remove(s)} disabled={busy} className="text-[11px] font-heading font-semibold text-[#ff0060] hover:underline">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
