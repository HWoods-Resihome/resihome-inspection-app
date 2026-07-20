/**
 * /admin/vendors — Vendor Management (app-admin only).
 *
 * The app-side replacement for hand-editing vendor Companies in HubSpot. Three
 * collapsible sections group the roster:
 *   • Recurring Vendors    — ResiWalk access + eligible for recurring
 *   • Maintenance Vendors  — ResiWalk access, not recurring-eligible
 *   • Deactivated Vendors  — access explicitly No (reactivatable)
 * Each vendor is a collapsible card; expanding shows its settings: tappable
 * Regions Serviced (multi-select, saves debounced), Eligible For Recurring +
 * After-Hours toggles, a Vendor Status (Active/Deactivated) toggle, and Delete.
 * A pencil beside the name opens inline name/email editing. Search + Filters
 * (Region / Recurring / Status) + Sort mirror the inspections home. Every write
 * goes straight to the HubSpot Company record and busts the vendor caches.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { PageHeader } from '@/components/PageHeader';
import { MultiFilter } from '@/components/MultiFilter';
import { PullToRefresh } from '@/components/PullToRefresh';
import { useAppDialog } from '@/components/AppDialog';
import { parseRegions, joinRegions } from '@/lib/vendorRegions';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const admin = await isAppAdmin(session?.realEmail || session?.email).catch(() => false);
  if (!admin) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};

interface VendorRow {
  id: string; name: string; email: string; regionsServiced: string;
  resiwalkAccess: boolean; eligibleForRecurring: boolean; afterHoursService: boolean;
  inspectionAccess: boolean; inspectionFull: boolean; hasPassword: boolean;
  lastActive?: string | null;   // most recent sign-in (ISO), null if never
}

type InspLevel = 'none' | 'limited' | 'full';
const inspLevelOf = (v: { inspectionAccess: boolean; inspectionFull?: boolean }): InspLevel =>
  !v.inspectionAccess ? 'none' : v.inspectionFull ? 'full' : 'limited';

// Last-active date, M-D-YY (e.g. 7-9-26). "Never" until the vendor first logs in.
const fmtActive = (iso?: string | null): string => {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
};

type SortField = 'name' | 'email' | 'regions';
const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'name', label: 'Name' }, { value: 'email', label: 'Email' }, { value: 'regions', label: 'Regions' },
];

// Instant repeat paint: snapshot the last-loaded roster in localStorage (the
// server caches too — this removes the spinner on back-navigation AND on a
// fresh app open; the background load() reconciles).
const SNAP_KEY = 'resiwalk_vendor_admin_v1';

// HubSpot's SEARCH index lags a fresh create by seconds-to-minutes, so a vendor
// added moments ago is missing from the search-backed roster and looks like it
// never saved. Remember recent creates locally and merge them into every load
// until the index catches up (or the entry expires).
const PENDING_KEY = 'resiwalk_vendor_pending_v1';
const PENDING_TTL_MS = 15 * 60 * 1000;
function readPendingCreates(): { row: VendorRow; at: number }[] {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return (Array.isArray(list) ? list : []).filter((p: any) => p?.row?.id && Date.now() - (p.at || 0) < PENDING_TTL_MS);
  } catch { return []; }
}
function writePendingCreates(list: { row: VendorRow; at: number }[]): void {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* quota */ }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function VendorManagement() {
  const dialog = useAppDialog();
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [regionOptions, setRegionOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inspPropError, setInspPropError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Search / filters / sort (mirrors the inspections home controls).
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [regionFilter, setRegionFilter] = useState<string[]>([]);
  const [recurringFilter, setRecurringFilter] = useState<string[]>([]);   // 'Yes' | 'No'
  const [statusFilter, setStatusFilter] = useState<string[]>([]);         // 'Active' | 'Deactivated'
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [sortOpen, setSortOpen] = useState(false);

  // Section + card expansion.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ recurring: true, maintenance: true, deactivated: false });
  const [openCards, setOpenCards] = useState<Set<string>>(new Set());
  // While a card is EXPANDED it stays PINNED to the section it was in when opened
  // — toggling status/recurring must not yank it into another section mid-edit.
  // Collapsing the card (or reloading the page) releases the pin and it regroups.
  const [pinnedSection, setPinnedSection] = useState<Record<string, string>>({});

  // Add form.
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRegions, setNewRegions] = useState<string[]>([]);
  const [newRecurring, setNewRecurring] = useState(true);
  const [newAfterHours, setNewAfterHours] = useState(false);
  const [newInspLevel, setNewInspLevel] = useState<InspLevel>('none');   // default: no Inspections
  const [adding, setAdding] = useState(false);

  // Inline name/email edit (pencil).
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Debounced region saves, one timer per vendor.
  const regionTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function load(refresh = false) {
    setLoadError(null);
    try {
      const r = await fetch(`/api/admin/vendors${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      let list: VendorRow[] = Array.isArray(d.vendors) ? d.vendors : [];
      // Merge recent local creates the HubSpot search index hasn't surfaced yet;
      // drop each pending entry the moment the server list includes it.
      const pending = readPendingCreates();
      const stillPending = pending.filter((p) =>
        !list.some((v) => v.id === p.row.id || v.email.toLowerCase() === p.row.email.toLowerCase()));
      if (stillPending.length !== pending.length) writePendingCreates(stillPending);
      if (stillPending.length) list = [...list, ...stillPending.map((p) => p.row)];
      setVendors(list);
      setRegionOptions(Array.isArray(d.regionOptions) ? d.regionOptions : []);
      setInspPropError(d.inspectionAccessError || null);
      try { localStorage.setItem(SNAP_KEY, JSON.stringify({ vendors: list, regionOptions: d.regionOptions || [] })); } catch { /* quota */ }
      // Server skipped the heavy region-catalog scan to answer fast — pull the
      // full option list quietly now that the page has painted.
      if (d.regionOptionsPending) {
        void fetch('/api/admin/vendors?only=regions', { cache: 'no-store' })
          .then((r2) => (r2.ok ? r2.json() : null))
          .then((d2) => {
            if (Array.isArray(d2?.regionOptions) && d2.regionOptions.length) {
              setRegionOptions((prev) => Array.from(new Set([...prev, ...d2.regionOptions])).sort());
            }
          })
          .catch(() => { /* options stay vendor-derived */ });
      }
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    } finally { setLoading(false); }
  }
  useEffect(() => {
    // Paint the last snapshot instantly (localStorage — survives app restarts,
    // unlike the old per-session copy), then refresh in the background.
    try {
      const snap = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
      if (snap?.vendors?.length) { setVendors(snap.vendors); setRegionOptions(snap.regionOptions || []); setLoading(false); }
    } catch { /* corrupt snapshot */ }
    void load();
  }, []);

  const allRegionOptions = useMemo(() => {
    const set = new Set(regionOptions);
    for (const v of vendors) for (const r of parseRegions(v.regionsServiced)) set.add(r);
    return Array.from(set).sort();
  }, [regionOptions, vendors]);

  // ── Filters + sort applied to the roster, THEN grouped into the 3 sections. ──
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = vendors;
    if (q) list = list.filter((v) => v.name.toLowerCase().includes(q) || v.email.toLowerCase().includes(q) || v.regionsServiced.toLowerCase().includes(q));
    if (regionFilter.length) list = list.filter((v) => { const rs = parseRegions(v.regionsServiced); return regionFilter.some((r) => rs.includes(r)); });
    if (recurringFilter.length) list = list.filter((v) => recurringFilter.includes(v.eligibleForRecurring ? 'Yes' : 'No'));
    if (statusFilter.length) list = list.filter((v) => statusFilter.includes(v.resiwalkAccess ? 'Active' : 'Deactivated'));
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sortField === 'email') return dir * a.email.localeCompare(b.email);
      if (sortField === 'regions') return dir * (parseRegions(a.regionsServiced).length - parseRegions(b.regionsServiced).length) || a.name.localeCompare(b.name);
      return dir * a.name.localeCompare(b.name);
    });
  }, [vendors, search, regionFilter, recurringFilter, statusFilter, sortField, sortDir]);

  const sectionKeyOf = (v: VendorRow) => (!v.resiwalkAccess ? 'deactivated' : v.eligibleForRecurring ? 'recurring' : 'maintenance');
  const sections = useMemo(() => {
    // An expanded (pinned) card stays where it was opened, even if its flags
    // changed — it regroups when collapsed.
    const groupOf = (v: VendorRow) => pinnedSection[v.id] || sectionKeyOf(v);
    return [
      { key: 'recurring', title: 'Recurring Vendors', rows: visible.filter((v) => groupOf(v) === 'recurring') },
      { key: 'maintenance', title: 'Maintenance Vendors', rows: visible.filter((v) => groupOf(v) === 'maintenance') },
      { key: 'deactivated', title: 'Deactivated Vendors', rows: visible.filter((v) => groupOf(v) === 'deactivated') },
    ];
  }, [visible, pinnedSection]);

  const activeFilterCount = regionFilter.length + recurringFilter.length + statusFilter.length;

  // ── Mutations (optimistic + PATCH; reload only on failure) ──
  async function patchVendor(id: string, patch: Record<string, unknown>): Promise<boolean> {
    try {
      const r = await fetch(`/api/admin/vendors/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return true;
    } catch (e: any) {
      void dialog.alert(`Update failed: ${e?.message || e}`);
      await load(true);
      return false;
    }
  }
  const mutateLocal = (id: string, patch: Partial<VendorRow>) =>
    setVendors((cur) => cur.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  function toggleFlag(v: VendorRow, key: 'eligibleForRecurring' | 'afterHoursService') {
    // Recurring requires an ACTIVE vendor (dependency rule).
    if (!v.resiwalkAccess && key === 'eligibleForRecurring') {
      void dialog.alert('Reactivate this vendor first — a deactivated vendor can’t be recurring-eligible.');
      return;
    }
    const next = !v[key];
    mutateLocal(v.id, { [key]: next } as Partial<VendorRow>);
    void patchVendor(v.id, { [key]: next });
  }

  // Tri-state Inspections access: none / limited (own work, any type) / full
  // (everything, like internal). Requires an ACTIVE vendor for limited/full.
  function setInspLevel(v: VendorRow, lvl: InspLevel) {
    if (lvl !== 'none' && !v.resiwalkAccess) {
      void dialog.alert('Reactivate this vendor first — a deactivated vendor can’t access Inspections.');
      return;
    }
    if (inspLevelOf(v) === lvl) return;
    mutateLocal(v.id, { inspectionAccess: lvl !== 'none', inspectionFull: lvl === 'full' });
    void patchVendor(v.id, { inspectionLevel: lvl });
  }

  async function toggleStatus(v: VendorRow) {
    const next = !v.resiwalkAccess;
    if (!next) {
      const ok = await dialog.confirm(
        `Deactivate ${v.name}?\n\nResiWalk Access flips to No in HubSpot — they can no longer sign in and drop out of every vendor picker. Recurring eligibility and Inspections access switch off too. Flip the toggle back any time to reactivate.`,
        { confirmLabel: 'Deactivate' });
      if (!ok) return;
    }
    // Dependency rule: deactivating force-clears recurring + inspections (the
    // server enforces the same in one HubSpot patch).
    mutateLocal(v.id, next ? { resiwalkAccess: true } : { resiwalkAccess: false, eligibleForRecurring: false, inspectionAccess: false, inspectionFull: false });
    void patchVendor(v.id, { resiwalkAccess: next });
  }

  function setVendorRegions(v: VendorRow, tokens: string[]) {
    const joined = joinRegions(tokens);
    mutateLocal(v.id, { regionsServiced: joined });
    // Debounce the write so rapid checkbox taps produce ONE HubSpot patch.
    if (regionTimers.current[v.id]) clearTimeout(regionTimers.current[v.id]);
    regionTimers.current[v.id] = setTimeout(() => {
      delete regionTimers.current[v.id];
      if (!joined) return;   // required — never blank the field from the picker
      void patchVendor(v.id, { regionsServiced: joined });
    }, 700);
  }

  async function deleteVendor(v: VendorRow) {
    const ok = await dialog.confirm(
      `DELETE ${v.name}?\n\nThis archives the Company record in HubSpot (removed from active records) and revokes their ResiWalk access. Prefer deactivating (Vendor Status toggle) if you may bring them back.`,
      { confirmLabel: 'Delete Vendor' });
    if (!ok) return;
    setBusyId(v.id);
    try {
      const r = await fetch(`/api/admin/vendors/${v.id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setVendors((cur) => cur.filter((x) => x.id !== v.id));
      try { localStorage.removeItem(SNAP_KEY); } catch { /* noop */ }
    } catch (e: any) { void dialog.alert(`Delete failed: ${e?.message || e}`); }
    finally { setBusyId(null); }
  }

  async function addVendor() {
    if (!newName.trim()) { void dialog.alert('Vendor name is required.'); return; }
    if (!EMAIL_RE.test(newEmail.trim())) { void dialog.alert('A valid email is required.'); return; }
    if (newRegions.length === 0) { void dialog.alert('Select at least one region serviced.'); return; }
    setAdding(true);
    try {
      const r = await fetch('/api/admin/vendors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), email: newEmail.trim(), regionsServiced: joinRegions(newRegions), eligibleForRecurring: newRecurring, afterHoursService: newAfterHours, inspectionLevel: newInspLevel }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // Show the new vendor IMMEDIATELY (HubSpot's search index can lag the
      // create by minutes) and remember it so background reloads keep it until
      // the index catches up.
      const row: VendorRow = {
        id: String(d.id), name: newName.trim(), email: newEmail.trim().toLowerCase(),
        regionsServiced: joinRegions(newRegions), resiwalkAccess: true,
        eligibleForRecurring: newRecurring, afterHoursService: newAfterHours,
        inspectionAccess: newInspLevel !== 'none', inspectionFull: newInspLevel === 'full', hasPassword: false,
      };
      setVendors((cur) => [...cur.filter((x) => x.id !== row.id), row]);
      writePendingCreates([...readPendingCreates(), { row, at: Date.now() }]);
      setAddOpen(false); setNewName(''); setNewEmail(''); setNewRegions([]); setNewRecurring(true); setNewAfterHours(false); setNewInspLevel('none');
      void dialog.alert(`${row.name} created${d.welcomeSent ? ' — welcome email sent.' : '.'}`);
      await load(true);
    } catch (e: any) { void dialog.alert(`Could not add vendor: ${e?.message || e}`); }
    finally { setAdding(false); }
  }

  // Vendor scorecards — service performance per vendor (open / past-due /
  // completed-90d / on-time %). Loaded once in the background after the roster;
  // matched by email first, display name as the legacy fallback.
  type VendorScore = { open: number; pastDue: number; completed90: number; onTimePct: number | null; lastCompletedAt: string | null };
  const [scores, setScores] = useState<{ byEmail: Record<string, VendorScore>; byName: Record<string, VendorScore> } | null>(null);
  useEffect(() => {
    void fetch('/api/admin/vendors/scorecards', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.byEmail || d?.byName) setScores({ byEmail: d.byEmail || {}, byName: d.byName || {} }); })
      .catch(() => { /* scorecards are additive — cards render without them */ });
  }, []);
  const scoreFor = (v: VendorRow): VendorScore | null =>
    scores?.byEmail[v.email.toLowerCase()] || scores?.byName[v.name.trim().toLowerCase()] || null;

  // Per-card welcome email (re)send — admin-triggered only, never bulk.
  const [welcomeBusy, setWelcomeBusy] = useState<string | null>(null);
  async function sendWelcome(v: VendorRow) {
    setWelcomeBusy(v.id);
    try {
      const r = await fetch(`/api/admin/vendors/${v.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Fields ride along as the fallback for a just-created record the
        // HubSpot search index hasn't surfaced yet.
        body: JSON.stringify({ action: 'welcome', name: v.name, email: v.email, regionsServiced: v.regionsServiced }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      void dialog.alert(`Welcome email sent to ${v.email}.`);
    } catch (e: any) { void dialog.alert(`Could not send welcome email: ${e?.message || e}`); }
    finally { setWelcomeBusy(null); }
  }

  function startEdit(v: VendorRow) { setEditId(v.id); setEditName(v.name); setEditEmail(v.email); }
  async function saveEdit() {
    if (!editId) return;
    if (!editName.trim()) { void dialog.alert('Vendor name is required.'); return; }
    if (!EMAIL_RE.test(editEmail.trim())) { void dialog.alert('A valid email is required.'); return; }
    setSavingEdit(true);
    mutateLocal(editId, { name: editName.trim(), email: editEmail.trim().toLowerCase() });
    const ok = await patchVendor(editId, { name: editName.trim(), email: editEmail.trim() });
    setSavingEdit(false);
    if (ok) setEditId(null);
  }

  const toggleCard = (id: string) => {
    setOpenCards((cur) => {
      const n = new Set(cur);
      if (n.has(id)) {
        n.delete(id);
        // Collapsing releases the pin → the card regroups into its true section.
        setPinnedSection((p) => { const { [id]: _gone, ...rest } = p; return rest; });
      } else {
        n.add(id);
        // Expanding pins the card to its CURRENT section so mid-edit flag changes
        // don't yank it away while you're still working on it.
        const v = vendors.find((x) => x.id === id);
        if (v) setPinnedSection((p) => ({ ...p, [id]: sectionKeyOf(v) }));
      }
      return n;
    });
  };

  const inputCls = 'focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white';
  const toggleCls = (on: boolean) => `relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-brand' : 'bg-gray-300'}`;
  const knobCls = (on: boolean) => `inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`;

  function VendorCard({ v }: { v: VendorRow }) {
    const expanded = openCards.has(v.id);
    const editing = editId === v.id;
    const score = scoreFor(v);
    return (
      <section className={`bg-white border rounded-xl shadow-sm overflow-hidden ${busyId === v.id ? 'opacity-60 pointer-events-none' : 'border-gray-200'}`}>
        {/* Collapsible card header — tap to expand settings. */}
        <button type="button" onClick={() => toggleCard(v.id)} aria-expanded={expanded}
          className="w-full px-3.5 py-3 bg-brand/5 hover:bg-brand/10 border-b border-brand/20 flex items-center gap-2.5 text-left transition">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className={`shrink-0 text-gray-500 transition-transform ${expanded ? 'rotate-90' : ''}`}><polyline points="9 18 15 12 9 6" /></svg>
          <div className="min-w-0 flex-1">
            {/* Full company name always visible — wraps instead of truncating. */}
            <span className="font-heading font-bold text-[15px] text-ink break-words block">{v.name}</span>
            <span className="text-[12px] text-gray-500 truncate block">{v.email}</span>
            {/* Own line so a long email can't truncate the date away. */}
            <span className="text-[11px] text-gray-400 block">Last active {fmtActive(v.lastActive)}</span>
          </div>
          <span className="shrink-0">
            {v.hasPassword
              ? <span className="text-[10px] font-heading font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5" title="Vendor has set their ResiWalk password">Active Login</span>
              : <span className="text-[10px] font-heading font-bold uppercase tracking-wide text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5" title="Vendor hasn't set a password yet — they self-onboard with an emailed code at first sign-in">No Login Yet</span>}
          </span>
        </button>

        {expanded && (
          <div className="px-4 py-3 space-y-3">
            {/* Scorecard strip — service performance (trailing 90 days). */}
            {score && (
              <div className="grid grid-cols-4 gap-1.5 text-center">
                {[
                  { label: 'Open', value: String(score.open), alert: false },
                  { label: 'Past Due', value: String(score.pastDue), alert: score.pastDue > 0 },
                  { label: 'Done 90d', value: String(score.completed90), alert: false },
                  { label: 'On-Time', value: score.onTimePct == null ? '—' : `${score.onTimePct}%`, alert: score.onTimePct != null && score.onTimePct < 80 },
                ].map((s) => (
                  <div key={s.label} className={`rounded-lg border px-1 py-1.5 ${s.alert ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
                    <div className={`font-heading font-bold text-[15px] tabular-nums ${s.alert ? 'text-red-600' : 'text-ink'}`}>{s.value}</div>
                    <div className="text-[10px] font-heading font-semibold uppercase tracking-wide text-gray-500">{s.label}</div>
                  </div>
                ))}
              </div>
            )}
            {editing ? (
              <div className="space-y-2.5">
                <div>
                  <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Company Name <span className="text-brand">*</span></label>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Email <span className="text-brand">*</span></label>
                  <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className={inputCls} />
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void saveEdit()} disabled={savingEdit}
                    className="flex-1 bg-brand hover:bg-brand-dark disabled:opacity-60 text-white font-heading font-bold py-2.5 rounded-lg text-sm">{savingEdit ? 'Saving…' : 'Save'}</button>
                  <button type="button" onClick={() => setEditId(null)} className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-heading font-semibold text-gray-700 hover:bg-gray-50">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-gray-700 truncate">{v.name} · {v.email}</span>
                <button type="button" onClick={() => startEdit(v)} aria-label={`Edit ${v.name}`} title="Edit name / email"
                  className="shrink-0 text-gray-400 hover:text-brand p-1">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
                </button>
              </div>
            )}

            {/* Regions Serviced — the value line IS the picker (tap to edit). */}
            <div>
              <span className="text-[11px] font-heading font-bold uppercase tracking-wide text-gray-400 block mb-1">Regions Serviced <span className="text-brand normal-case">*</span></span>
              <MultiFilter
                label="Regions"
                sheet
                selectAll
                options={allRegionOptions.map((r) => ({ value: r, label: r }))}
                selected={parseRegions(v.regionsServiced)}
                onChange={(next) => setVendorRegions(v, next)}
                triggerLabel={v.regionsServiced || 'Tap To Set Regions'}
                className="w-full text-left text-[13px] text-gray-700 border border-gray-200 hover:border-brand/50 rounded-lg px-3 py-2 bg-white flex items-center justify-between gap-2"
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[13px] text-gray-700">Vendor Status <span className={`ml-1 text-[11px] font-heading font-bold ${v.resiwalkAccess ? 'text-emerald-600' : 'text-gray-400'}`}>{v.resiwalkAccess ? 'Active' : 'Deactivated'}</span></span>
              <button type="button" onClick={() => void toggleStatus(v)} className={toggleCls(v.resiwalkAccess)} aria-pressed={v.resiwalkAccess} title={v.resiwalkAccess ? 'Deactivate — revokes ResiWalk access' : 'Reactivate — restores ResiWalk access'}><span className={knobCls(v.resiwalkAccess)} /></button>
            </div>
            <div className={`flex items-center justify-between ${v.resiwalkAccess ? '' : 'opacity-50'}`}>
              <span className="text-[13px] text-gray-700">Eligible For Recurring</span>
              <button type="button" onClick={() => toggleFlag(v, 'eligibleForRecurring')} className={toggleCls(v.eligibleForRecurring)} aria-pressed={v.eligibleForRecurring} title={v.resiwalkAccess ? 'Can be assigned recurring services' : 'Reactivate the vendor first'}><span className={knobCls(v.eligibleForRecurring)} /></button>
            </div>
            <div className={`flex items-center justify-between gap-2 ${v.resiwalkAccess ? '' : 'opacity-50'}`}>
              <span className="text-[13px] text-gray-700 shrink-0">Access To Inspections</span>
              {/* Tri-state: None (no Inspections app) / Limited (their assigned
                  work only, any type) / Full (everything, like internal). */}
              <div className="flex rounded-lg border border-gray-300 overflow-hidden" role="radiogroup" aria-label="Access to Inspections">
                {(['none', 'limited', 'full'] as const).map((lvl) => {
                  const on = inspLevelOf(v) === lvl;
                  return (
                    <button key={lvl} type="button" role="radio" aria-checked={on} onClick={() => setInspLevel(v, lvl)}
                      title={lvl === 'none' ? 'No Inspections access' : lvl === 'limited' ? 'Only inspections assigned to them (any type)' : 'Full access — like an internal user'}
                      className={`px-2.5 py-1.5 text-[11px] font-heading font-bold capitalize border-l first:border-l-0 border-gray-300 ${on ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                      {lvl}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-gray-700">After-Hours Service</span>
              <button type="button" onClick={() => toggleFlag(v, 'afterHoursService')} className={toggleCls(v.afterHoursService)} aria-pressed={v.afterHoursService}><span className={knobCls(v.afterHoursService)} /></button>
            </div>

            <div className="pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
              <button type="button" onClick={() => void deleteVendor(v)} className="text-sm font-heading font-semibold text-red-600 hover:underline">Delete Vendor</button>
              <button type="button" onClick={() => void sendWelcome(v)} disabled={welcomeBusy === v.id}
                title="Emails this vendor a welcome + sign-in link"
                className="text-sm font-heading font-semibold text-brand hover:underline disabled:opacity-50">
                {welcomeBusy === v.id ? 'Sending…' : 'Send Welcome Email'}
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  return (
    <>
      <Head><title>Vendor Management — ResiWalk</title></Head>
      {/* Swipe-down refresh, same as the inspections home. */}
      <PullToRefresh onRefresh={() => load(true)} />
      <main className="min-h-screen bg-gray-50 pb-16">
        <PageHeader title="Vendor Management" backHref="/" onBack={() => { window.location.href = '/'; }} />
        <div className="max-w-3xl mx-auto px-4 pt-4">
          {inspPropError && (
            <div className="mb-3 rounded-xl bg-amber-50 border border-amber-300 px-3 py-2.5 text-[13px] text-amber-900">
              <span className="font-heading font-bold">Vendor field provisioning: </span>{inspPropError}
            </div>
          )}
          {/* Search · Filters · Sort · Add — mirrors the inspections home row. */}
          <div className="flex items-center gap-2 mb-2">
            <div className="relative flex-1 min-w-0">
              <input type="text" placeholder="Search name, email, or region…" value={search} onChange={(e) => setSearch(e.target.value)}
                className="w-full text-sm border border-gray-300 rounded-lg pl-3 pr-9 py-2.5 bg-white focus:outline-none focus:border-brand" />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </div>
            <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-label="Filters"
              className={`shrink-0 inline-flex items-center justify-center gap-1 w-14 h-11 rounded-lg border bg-white transition-colors ${activeFilterCount ? 'border-brand text-brand' : 'border-gray-300 text-gray-600 hover:text-brand hover:border-brand/50'}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${filtersOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <button type="button" onClick={() => setAddOpen((o) => !o)}
              className="shrink-0 inline-flex items-center gap-1 bg-brand hover:bg-brand-dark text-white font-heading font-bold text-sm px-3.5 h-11 rounded-lg transition whitespace-nowrap">
              {addOpen ? 'Close' : '+ Add'}
            </button>
          </div>

          {/* Filter + sort row (collapsible, like the inspections page). */}
          {filtersOpen && (
            <div className="grid grid-cols-4 gap-1.5 mb-3">
              <MultiFilter label="Region" sheet options={allRegionOptions.map((r) => ({ value: r, label: r }))} selected={regionFilter} onChange={setRegionFilter} />
              <MultiFilter label="Recurring" options={[{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]} selected={recurringFilter} onChange={setRecurringFilter} />
              <MultiFilter label="Status" options={[{ value: 'Active', label: 'Active' }, { value: 'Deactivated', label: 'Deactivated' }]} selected={statusFilter} onChange={setStatusFilter} />
              <div className="relative">
                <button type="button" onClick={() => setSortOpen((o) => !o)} aria-expanded={sortOpen}
                  className="w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between border-gray-300 text-gray-700 hover:border-brand/50">
                  <span className="truncate">Sort: {SORT_OPTIONS.find((o) => o.value === sortField)?.label} {sortDir === 'asc' ? '↑' : '↓'}</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${sortOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
                </button>
                {sortOpen && (
                  <>
                    <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setSortOpen(false)} />
                    <div className="absolute right-0 mt-1 z-50 w-40 rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
                      {SORT_OPTIONS.map((o) => (
                        <button key={o.value} type="button"
                          onClick={() => { if (sortField === o.value) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortField(o.value); setSortDir('asc'); } }}
                          className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-gray-50 ${sortField === o.value ? 'text-brand font-semibold' : 'text-gray-700'}`}>
                          {o.label}
                          {sortField === o.value && <span>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Add form */}
          {addOpen && (
            <section className="mb-4 bg-white border border-brand/30 rounded-xl p-4 shadow-sm">
              <h2 className="font-heading font-bold text-lg text-ink mb-3">New Vendor</h2>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1">Company Name <span className="text-brand">*</span></label>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} className={inputCls} placeholder="e.g. GreenBlade Lawn Co." />
                </div>
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1">Email <span className="text-brand">*</span></label>
                  <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className={inputCls} placeholder="workorders@vendor.com" />
                  <p className="text-[11px] text-gray-500 mt-1">Their ResiWalk sign-in + work-order notifications go here.</p>
                </div>
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1">Regions Serviced <span className="text-brand">*</span></label>
                  <MultiFilter label="Regions" options={allRegionOptions.map((r) => ({ value: r, label: r }))} selected={newRegions} onChange={setNewRegions} sheet selectAll
                    triggerLabel={newRegions.length ? joinRegions(newRegions) : 'Tap To Select Regions'}
                    className="w-full text-left text-[13px] text-gray-700 border border-gray-300 hover:border-brand/50 rounded-lg px-3 py-2.5 bg-white flex items-center justify-between gap-2" />
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-sm font-heading font-semibold text-ink">Eligible For Recurring</span>
                  <button type="button" onClick={() => setNewRecurring((v) => !v)} className={toggleCls(newRecurring)} aria-pressed={newRecurring}><span className={knobCls(newRecurring)} /></button>
                </div>
                <div className="flex items-center justify-between gap-2 py-1">
                  <span className="text-sm font-heading font-semibold text-ink shrink-0">Access To Inspections</span>
                  <div className="flex rounded-lg border border-gray-300 overflow-hidden" role="radiogroup" aria-label="Access to Inspections">
                    {(['none', 'limited', 'full'] as const).map((lvl) => (
                      <button key={lvl} type="button" role="radio" aria-checked={newInspLevel === lvl} onClick={() => setNewInspLevel(lvl)}
                        className={`px-2.5 py-1.5 text-[11px] font-heading font-bold capitalize border-l first:border-l-0 border-gray-300 ${newInspLevel === lvl ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                        {lvl}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-sm font-heading font-semibold text-ink">After-Hours Service</span>
                  <button type="button" onClick={() => setNewAfterHours((v) => !v)} className={toggleCls(newAfterHours)} aria-pressed={newAfterHours}><span className={knobCls(newAfterHours)} /></button>
                </div>
                <button type="button" onClick={() => void addVendor()} disabled={adding}
                  className="w-full bg-brand hover:bg-brand-dark disabled:opacity-60 text-white font-heading font-bold py-3 rounded-lg transition">
                  {adding ? 'Creating In HubSpot…' : 'Create Vendor'}
                </button>
              </div>
            </section>
          )}

          {/* The three roster sections. */}
          {loading ? (
            <div className="text-center py-16"><div className="inline-block w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" /></div>
          ) : loadError ? (
            <div className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700">Could not load vendors: {loadError}</div>
          ) : (
            <div className="space-y-4">
              {sections.map((s) => {
                const open = openSections[s.key];
                return (
                  <section key={s.key} className="rounded-xl shadow-md overflow-hidden bg-white border border-gray-200">
                    <button type="button" onClick={() => setOpenSections((cur) => ({ ...cur, [s.key]: !cur[s.key] }))} aria-expanded={open}
                      className="w-full bg-brand/5 hover:bg-brand/10 border-b border-brand/20 px-4 py-3 flex items-center gap-3 text-left transition">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                        className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}><polyline points="9 18 15 12 9 6" /></svg>
                      <h2 className="font-heading font-bold text-lg truncate min-w-0 flex-1 text-ink">{s.title}</h2>
                      <span className="shrink-0 text-sm bg-brand text-white font-heading font-semibold px-2.5 py-0.5 rounded-full">{s.rows.length}</span>
                    </button>
                    {open && (
                      <div className="p-3 space-y-2.5 bg-gray-50">
                        {s.rows.length === 0
                          ? <p className="text-sm text-gray-500 text-center py-4">No vendors here{activeFilterCount || search ? ' (check search/filters)' : ''}.</p>
                          : s.rows.map((v) => <VendorCard key={v.id} v={v} />)}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
