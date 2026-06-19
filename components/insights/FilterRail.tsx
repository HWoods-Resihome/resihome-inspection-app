/**
 * Left rail of global filters for the Insights dashboard. CLIENT-SIDE ONLY —
 * filters apply to every card (the Dashboard runs applyFilters() on the rows).
 * State lives in the Dashboard and is persisted to localStorage there.
 *
 *   Date range  (on scheduledDate; default = all)
 *   Inspector   (multi-select by email, name labels)
 *   Property    (search + multi-select on propertyAddress)
 *   Region      (multi-select)
 *   Inspection type (multi-select templateType)
 */
import { useMemo, useState } from 'react';
import { templateLabel } from '@/lib/templateLabels';
import {
  type InsightsFilters, type InspectorOption,
  inspectorOptions, propertyOptions, regionOptions, templateTypeOptions, REGION_NONE,
} from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-gray-100 pb-3 mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-left mb-2"
      >
        <span className="font-heading font-bold text-xs uppercase tracking-wide text-gray-500">
          {title}{count ? <span className="text-brand ml-1">· {count}</span> : null}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && children}
    </div>
  );
}

function CheckRow({ checked, label, hint, onChange }: { checked: boolean; label: string; hint?: string; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 py-1 cursor-pointer text-sm">
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-brand h-3.5 w-3.5 shrink-0" />
      <span className="truncate text-gray-700 flex-1 min-w-0" title={label}>{label}</span>
      {hint != null && <span className="text-[11px] text-gray-400 shrink-0">{hint}</span>}
    </label>
  );
}

export function FilterRail({
  rows, filters, onChange, onReset,
}: {
  rows: InsightsRow[];
  filters: InsightsFilters;
  onChange: (next: InsightsFilters) => void;
  onReset: () => void;
}) {
  const inspectors: InspectorOption[] = useMemo(() => inspectorOptions(rows), [rows]);
  const properties = useMemo(() => propertyOptions(rows), [rows]);
  const regions = useMemo(() => regionOptions(rows), [rows]);
  const types = useMemo(() => templateTypeOptions(rows), [rows]);

  const [propSearch, setPropSearch] = useState('');
  const filteredProps = useMemo(() => {
    const q = propSearch.trim().toLowerCase();
    const base = q ? properties.filter((p) => p.toLowerCase().includes(q)) : properties;
    return base.slice(0, 200); // cap the rendered list
  }, [properties, propSearch]);

  const set = (patch: Partial<InsightsFilters>) => onChange({ ...filters, ...patch });
  const activeCount =
    (filters.dateFrom || filters.dateTo ? 1 : 0) +
    filters.inspectorEmails.length + filters.properties.length +
    filters.regions.length + filters.templateTypes.length;

  return (
    <aside className="w-full lg:w-64 shrink-0 bg-white rounded-2xl border border-gray-200 shadow-sm p-4 self-start lg:sticky lg:top-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-heading font-bold text-sm text-ink">Filters{activeCount ? <span className="text-brand"> · {activeCount}</span> : null}</h2>
        <button type="button" onClick={onReset} className="text-xs font-heading font-semibold text-gray-500 hover:text-brand">
          Reset
        </button>
      </div>

      <Section title="Date range (scheduled)">
        <div className="flex flex-col gap-2">
          <label className="text-[11px] text-gray-500">
            From
            <input
              type="date" value={filters.dateFrom || ''}
              onChange={(e) => set({ dateFrom: e.target.value || null })}
              className="focus-brand w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm mt-0.5"
            />
          </label>
          <label className="text-[11px] text-gray-500">
            To
            <input
              type="date" value={filters.dateTo || ''}
              onChange={(e) => set({ dateTo: e.target.value || null })}
              className="focus-brand w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm mt-0.5"
            />
          </label>
        </div>
      </Section>

      <Section title="Inspector" count={filters.inspectorEmails.length}>
        <div className="max-h-48 overflow-auto pr-1">
          {inspectors.length === 0 ? <div className="text-xs text-gray-400">None</div> :
            inspectors.map((o) => (
              <CheckRow
                key={o.email}
                checked={filters.inspectorEmails.includes(o.email)}
                label={o.label} hint={String(o.count)}
                onChange={() => set({ inspectorEmails: toggle(filters.inspectorEmails, o.email) })}
              />
            ))}
        </div>
      </Section>

      <Section title="Property" count={filters.properties.length}>
        <input
          type="text" value={propSearch} onChange={(e) => setPropSearch(e.target.value)}
          placeholder="Search address…"
          className="focus-brand w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm mb-2"
        />
        <div className="max-h-48 overflow-auto pr-1">
          {filteredProps.length === 0 ? <div className="text-xs text-gray-400">No matches</div> :
            filteredProps.map((p) => (
              <CheckRow
                key={p} checked={filters.properties.includes(p)} label={p}
                onChange={() => set({ properties: toggle(filters.properties, p) })}
              />
            ))}
        </div>
      </Section>

      <Section title="Region" count={filters.regions.length}>
        <div className="max-h-40 overflow-auto pr-1">
          {regions.length === 0 ? <div className="text-xs text-gray-400">None</div> :
            regions.map((r) => (
              <CheckRow
                key={r} checked={filters.regions.includes(r)}
                label={r === REGION_NONE ? '(no region)' : r}
                onChange={() => set({ regions: toggle(filters.regions, r) })}
              />
            ))}
        </div>
      </Section>

      <Section title="Inspection type" count={filters.templateTypes.length}>
        <div className="max-h-48 overflow-auto pr-1">
          {types.length === 0 ? <div className="text-xs text-gray-400">None</div> :
            types.map((t) => (
              <CheckRow
                key={t} checked={filters.templateTypes.includes(t)} label={templateLabel(t)}
                onChange={() => set({ templateTypes: toggle(filters.templateTypes, t) })}
              />
            ))}
        </div>
      </Section>
    </aside>
  );
}
