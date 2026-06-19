/**
 * Left rail of global filters for the Insights dashboard (dark). CLIENT-SIDE
 * ONLY — filters apply to every card (the Dashboard runs applyFilters() on the
 * rows). State lives in the Dashboard and is persisted to localStorage there.
 *
 * Order (Region near the top, per the dashboard brief):
 *   Date range  (on scheduledDate; default = all)
 *   Region      (multi-select)
 *   Inspector   (multi-select by email, name labels)
 *   Property    (search + multi-select on propertyAddress)
 *   Inspection type (multi-select templateType)
 */
import { useMemo, useState } from 'react';
import { templateLabel } from '@/lib/templateLabels';
import {
  type InsightsFilters, type InspectorOption,
  inspectorOptions, propertyOptions, regionOptions, templateTypeOptions, propertyStatusOptions,
  REGION_NONE, STATUS_NONE,
} from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-white/10 pb-3 mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-left mb-2"
      >
        <span className="font-heading font-bold text-[11px] uppercase tracking-wide text-[#a1a1aa]">
          {title}{count ? <span className="text-[#ff0060] ml-1">· {count}</span> : null}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-[#71717a] transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && children}
    </div>
  );
}

function CheckRow({ checked, label, hint, onChange }: { checked: boolean; label: string; hint?: string; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 py-1 cursor-pointer text-[13px]">
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-[#ff0060] h-3.5 w-3.5 shrink-0" />
      <span className="truncate text-[#f4f4f5] flex-1 min-w-0" title={label}>{label}</span>
      {hint != null && <span className="text-[11px] text-[#71717a] shrink-0">{hint}</span>}
    </label>
  );
}

const dateInputCls =
  'w-full border border-white/10 bg-[#232329] text-[#f4f4f5] rounded-lg px-2 py-1.5 text-sm mt-0.5 focus:outline-none focus:border-[#ff0060] [color-scheme:dark]';

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
  const statuses = useMemo(() => propertyStatusOptions(rows), [rows]);
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
    filters.regions.length + filters.templateTypes.length + (filters.propertyStatuses?.length || 0);

  return (
    <aside className="bg-[#18181c] rounded-xl border border-white/10 p-3.5 self-start lg:sticky lg:top-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-heading font-bold text-[13px] text-[#f4f4f5]">Filters{activeCount ? <span className="text-[#ff0060]"> · {activeCount}</span> : null}</h2>
        <button type="button" onClick={onReset} className="text-[11px] font-heading font-semibold text-[#a1a1aa] hover:text-[#ff0060]">
          Reset
        </button>
      </div>

      <Section title="Date range (scheduled)">
        <div className="flex flex-col gap-2">
          <label className="text-[11px] text-[#a1a1aa]">
            From
            <input
              type="date" value={filters.dateFrom || ''}
              onChange={(e) => set({ dateFrom: e.target.value || null })}
              className={dateInputCls}
            />
          </label>
          <label className="text-[11px] text-[#a1a1aa]">
            To
            <input
              type="date" value={filters.dateTo || ''}
              onChange={(e) => set({ dateTo: e.target.value || null })}
              className={dateInputCls}
            />
          </label>
        </div>
      </Section>

      <Section title="Region" count={filters.regions.length}>
        <div className="max-h-40 overflow-auto pr-1">
          {regions.length === 0 ? <div className="text-xs text-[#71717a]">None</div> :
            regions.map((r) => (
              <CheckRow
                key={r} checked={filters.regions.includes(r)}
                label={r === REGION_NONE ? '(no region)' : r}
                onChange={() => set({ regions: toggle(filters.regions, r) })}
              />
            ))}
        </div>
      </Section>

      <Section title="Property status" count={filters.propertyStatuses?.length || 0}>
        <div className="max-h-40 overflow-auto pr-1">
          {statuses.length === 0 ? <div className="text-xs text-[#71717a]">None</div> :
            statuses.map((s) => (
              <CheckRow
                key={s} checked={(filters.propertyStatuses || []).includes(s)}
                label={s === STATUS_NONE ? '(unknown)' : s}
                onChange={() => set({ propertyStatuses: toggle(filters.propertyStatuses || [], s) })}
              />
            ))}
        </div>
      </Section>

      <Section title="Inspector" count={filters.inspectorEmails.length}>
        <div className="max-h-48 overflow-auto pr-1">
          {inspectors.length === 0 ? <div className="text-xs text-[#71717a]">None</div> :
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
          className="w-full border border-white/10 bg-[#232329] text-[#f4f4f5] placeholder-[#71717a] rounded-lg px-2 py-1.5 text-sm mb-2 focus:outline-none focus:border-[#ff0060]"
        />
        <div className="max-h-48 overflow-auto pr-1">
          {filteredProps.length === 0 ? <div className="text-xs text-[#71717a]">No matches</div> :
            filteredProps.map((p) => (
              <CheckRow
                key={p} checked={filters.properties.includes(p)} label={p}
                onChange={() => set({ properties: toggle(filters.properties, p) })}
              />
            ))}
        </div>
      </Section>

      <Section title="Inspection type" count={filters.templateTypes.length}>
        <div className="max-h-48 overflow-auto pr-1">
          {types.length === 0 ? <div className="text-xs text-[#71717a]">None</div> :
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
