/**
 * /admin/vendors — Vendor Management (app-admin only).
 *
 * The app-side replacement for hand-editing vendor Companies in HubSpot: lists
 * every Company with ResiWalk access (name · email · regions serviced · access ·
 * eligible-for-recurring · after-hours · login state), adds new vendors (creates
 * the Company record in HubSpot), edits fields, toggles recurring/after-hours
 * eligibility, and deactivates (access → No) or deletes (archives) a vendor —
 * both of which revoke ResiWalk access. Every change writes straight to HubSpot
 * and busts the app's vendor caches, so pickers and vendor logins stay in tune.
 */
import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { PageHeader } from '@/components/PageHeader';
import { MultiFilter } from '@/components/MultiFilter';
import { useAppDialog } from '@/components/AppDialog';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const admin = await isAppAdmin(session?.realEmail || session?.email).catch(() => false);
  if (!admin) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};

interface VendorRow {
  id: string; name: string; email: string; regionsServiced: string;
  resiwalkAccess: boolean; eligibleForRecurring: boolean; afterHoursService: boolean; hasPassword: boolean;
}

const splitRegions = (s: string): string[] => String(s || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
const joinRegions = (a: string[]): string => a.join('; ');

export default function VendorManagement() {
  const dialog = useAppDialog();
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [regionOptions, setRegionOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);   // row-level in-flight guard
  const [search, setSearch] = useState('');

  // ── Add form ──
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRegions, setNewRegions] = useState<string[]>([]);
  const [newRecurring, setNewRecurring] = useState(true);
  const [newAfterHours, setNewAfterHours] = useState(false);
  const [adding, setAdding] = useState(false);

  // ── Edit state (one row at a time) ──
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRegions, setEditRegions] = useState<string[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);

  async function load() {
    setLoadError(null);
    try {
      const r = await fetch('/api/admin/vendors', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setVendors(Array.isArray(d.vendors) ? d.vendors : []);
      setRegionOptions(Array.isArray(d.regionOptions) ? d.regionOptions : []);
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  // Region options for the pickers: the app's live region set, PLUS any values
  // already stored on vendors (so legacy formatting is never silently dropped).
  const allRegionOptions = useMemo(() => {
    const set = new Set(regionOptions);
    for (const v of vendors) for (const r of splitRegions(v.regionsServiced)) set.add(r);
    return Array.from(set).sort();
  }, [regionOptions, vendors]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) => v.name.toLowerCase().includes(q) || v.email.toLowerCase().includes(q) || v.regionsServiced.toLowerCase().includes(q));
  }, [vendors, search]);

  async function addVendor() {
    if (!newName.trim()) { void dialog.alert('Vendor name is required.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail.trim())) { void dialog.alert('A valid email is required.'); return; }
    if (newRegions.length === 0) { void dialog.alert('Select at least one region serviced.'); return; }
    setAdding(true);
    try {
      const r = await fetch('/api/admin/vendors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), email: newEmail.trim(), regionsServiced: joinRegions(newRegions), eligibleForRecurring: newRecurring, afterHoursService: newAfterHours }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setAddOpen(false); setNewName(''); setNewEmail(''); setNewRegions([]); setNewRecurring(true); setNewAfterHours(false);
      await load();
    } catch (e: any) { void dialog.alert(`Could not add vendor: ${e?.message || e}`); }
    finally { setAdding(false); }
  }

  async function patchVendor(id: string, patch: Record<string, unknown>, opts?: { skipReload?: boolean }) {
    setBusyId(id);
    try {
      const r = await fetch(`/api/admin/vendors/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (!opts?.skipReload) await load();
      return true;
    } catch (e: any) { void dialog.alert(`Update failed: ${e?.message || e}`); return false; }
    finally { setBusyId(null); }
  }

  async function toggleRecurring(v: VendorRow) {
    // Optimistic flip; reconciled by the reload inside patchVendor on failure.
    setVendors((cur) => cur.map((x) => (x.id === v.id ? { ...x, eligibleForRecurring: !v.eligibleForRecurring } : x)));
    const ok = await patchVendor(v.id, { eligibleForRecurring: !v.eligibleForRecurring }, { skipReload: true });
    if (!ok) await load();
  }
  async function toggleAfterHours(v: VendorRow) {
    setVendors((cur) => cur.map((x) => (x.id === v.id ? { ...x, afterHoursService: !v.afterHoursService } : x)));
    const ok = await patchVendor(v.id, { afterHoursService: !v.afterHoursService }, { skipReload: true });
    if (!ok) await load();
  }

  async function deactivateVendor(v: VendorRow) {
    const ok = await dialog.confirm(
      `Deactivate ${v.name}?\n\nResiWalk Access flips to No in HubSpot — they can no longer sign in and drop out of every vendor picker. The Company record is kept (reactivate any time from HubSpot).`,
      { confirmLabel: 'Deactivate' });
    if (!ok) return;
    if (await patchVendor(v.id, { resiwalkAccess: false }, { skipReload: true })) {
      setVendors((cur) => cur.filter((x) => x.id !== v.id));
    }
  }

  async function deleteVendor(v: VendorRow) {
    const ok = await dialog.confirm(
      `DELETE ${v.name}?\n\nThis archives the Company record in HubSpot (removed from active records) and revokes their ResiWalk access. Prefer Deactivate if you may bring them back.`,
      { confirmLabel: 'Delete vendor' });
    if (!ok) return;
    setBusyId(v.id);
    try {
      const r = await fetch(`/api/admin/vendors/${v.id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setVendors((cur) => cur.filter((x) => x.id !== v.id));
    } catch (e: any) { void dialog.alert(`Delete failed: ${e?.message || e}`); }
    finally { setBusyId(null); }
  }

  function startEdit(v: VendorRow) {
    setEditId(v.id); setEditName(v.name); setEditEmail(v.email); setEditRegions(splitRegions(v.regionsServiced));
  }
  async function saveEdit() {
    if (!editId) return;
    if (!editName.trim()) { void dialog.alert('Vendor name is required.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(editEmail.trim())) { void dialog.alert('A valid email is required.'); return; }
    if (editRegions.length === 0) { void dialog.alert('Select at least one region serviced.'); return; }
    setSavingEdit(true);
    const ok = await patchVendor(editId, { name: editName.trim(), email: editEmail.trim(), regionsServiced: joinRegions(editRegions) });
    setSavingEdit(false);
    if (ok) setEditId(null);
  }

  const inputCls = 'focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white';
  const toggleCls = (on: boolean) => `relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-brand' : 'bg-gray-300'}`;
  const knobCls = (on: boolean) => `inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`;

  return (
    <>
      <Head><title>Vendor Management — ResiWalk</title></Head>
      <main className="min-h-screen bg-gray-50 pb-16">
        <PageHeader title="Vendor Management" backHref="/" onBack={() => { window.location.href = '/'; }} />
        <div className="max-w-3xl mx-auto px-4 pt-4">
          <p className="text-[13px] text-gray-500 mb-4 leading-relaxed">
            Vendors with ResiWalk access. Changes save straight to the HubSpot Company record — access, recurring eligibility, and pickers update immediately.
          </p>

          {/* Search + Add */}
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1 min-w-0">
              <input type="text" placeholder="Search name, email, or region…" value={search} onChange={(e) => setSearch(e.target.value)}
                className="w-full text-sm border border-gray-300 rounded-lg pl-3 pr-9 py-2.5 bg-white focus:outline-none focus:border-brand" />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </div>
            <button type="button" onClick={() => setAddOpen((o) => !o)}
              className="shrink-0 inline-flex items-center gap-1.5 bg-brand hover:bg-brand-dark text-white font-heading font-bold text-sm px-4 py-2.5 rounded-lg transition">
              {addOpen ? 'Close' : '+ Add Vendor'}
            </button>
          </div>

          {/* Add form */}
          {addOpen && (
            <section className="mb-5 bg-white border border-brand/30 rounded-xl p-4 shadow-sm">
              <h2 className="font-heading font-bold text-lg text-ink mb-3">New Vendor</h2>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1">Company name <span className="text-brand">*</span></label>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} className={inputCls} placeholder="e.g. GreenBlade Lawn Co." />
                </div>
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1">Email <span className="text-brand">*</span></label>
                  <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className={inputCls} placeholder="workorders@vendor.com" />
                  <p className="text-[11px] text-gray-500 mt-1">Their ResiWalk sign-in + work-order notifications go here.</p>
                </div>
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1">Regions serviced <span className="text-brand">*</span></label>
                  <MultiFilter label="Regions" options={allRegionOptions.map((r) => ({ value: r, label: r }))} selected={newRegions} onChange={setNewRegions} sheet />
                  {newRegions.length > 0 && <p className="text-[12px] text-gray-600 mt-1.5">{joinRegions(newRegions)}</p>}
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-sm font-heading font-semibold text-ink">Eligible for recurring services</span>
                  <button type="button" onClick={() => setNewRecurring((v) => !v)} className={toggleCls(newRecurring)} aria-pressed={newRecurring}><span className={knobCls(newRecurring)} /></button>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-sm font-heading font-semibold text-ink">After-hours service</span>
                  <button type="button" onClick={() => setNewAfterHours((v) => !v)} className={toggleCls(newAfterHours)} aria-pressed={newAfterHours}><span className={knobCls(newAfterHours)} /></button>
                </div>
                <button type="button" onClick={() => void addVendor()} disabled={adding}
                  className="w-full bg-brand hover:bg-brand-dark disabled:opacity-60 text-white font-heading font-bold py-3 rounded-lg transition">
                  {adding ? 'Creating in HubSpot…' : 'Create Vendor'}
                </button>
              </div>
            </section>
          )}

          {/* List */}
          {loading ? (
            <div className="text-center py-16"><div className="inline-block w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" /></div>
          ) : loadError ? (
            <div className="bg-white border border-red-200 rounded-xl p-4 text-sm text-red-700">Could not load vendors: {loadError}</div>
          ) : filtered.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-6 text-sm text-gray-500 text-center">No vendors{search ? ' match your search' : ' with ResiWalk access yet'}.</div>
          ) : (
            <div className="space-y-3">
              {filtered.map((v) => (
                <section key={v.id} className={`bg-white border rounded-xl shadow-sm overflow-hidden ${busyId === v.id ? 'opacity-60 pointer-events-none' : 'border-gray-200'}`}>
                  {editId === v.id ? (
                    <div className="p-4 space-y-3">
                      <div>
                        <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Company name <span className="text-brand">*</span></label>
                        <input value={editName} onChange={(e) => setEditName(e.target.value)} className={inputCls} />
                      </div>
                      <div>
                        <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Email <span className="text-brand">*</span></label>
                        <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className={inputCls} />
                      </div>
                      <div>
                        <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Regions serviced <span className="text-brand">*</span></label>
                        <MultiFilter label="Regions" options={allRegionOptions.map((r) => ({ value: r, label: r }))} selected={editRegions} onChange={setEditRegions} sheet />
                        {editRegions.length > 0 && <p className="text-[12px] text-gray-600 mt-1.5">{joinRegions(editRegions)}</p>}
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button type="button" onClick={() => void saveEdit()} disabled={savingEdit}
                          className="flex-1 bg-brand hover:bg-brand-dark disabled:opacity-60 text-white font-heading font-bold py-2.5 rounded-lg text-sm">{savingEdit ? 'Saving…' : 'Save'}</button>
                        <button type="button" onClick={() => setEditId(null)} className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-heading font-semibold text-gray-700 hover:bg-gray-50">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="px-4 py-3 bg-brand/5 border-b border-brand/20 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="font-heading font-bold text-base text-ink truncate">{v.name}</h3>
                          <p className="text-[12px] text-gray-500 truncate">{v.email}</p>
                        </div>
                        <div className="shrink-0 flex items-center gap-1.5">
                          {v.hasPassword
                            ? <span className="text-[10px] font-heading font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5" title="Vendor has set their ResiWalk password">Active login</span>
                            : <span className="text-[10px] font-heading font-bold uppercase tracking-wide text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5" title="Vendor hasn't set a password yet — they self-onboard with an emailed code at first sign-in">No login yet</span>}
                        </div>
                      </div>
                      <div className="px-4 py-3 space-y-2.5">
                        <div className="text-[13px] text-gray-700">
                          <span className="text-[11px] font-heading font-bold uppercase tracking-wide text-gray-400 block mb-0.5">Regions serviced</span>
                          {v.regionsServiced || <span className="text-amber-600">None set</span>}
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] text-gray-700">Eligible for recurring</span>
                          <button type="button" onClick={() => void toggleRecurring(v)} className={toggleCls(v.eligibleForRecurring)} aria-pressed={v.eligibleForRecurring} title="Can be assigned recurring services"><span className={knobCls(v.eligibleForRecurring)} /></button>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] text-gray-700">After-hours service</span>
                          <button type="button" onClick={() => void toggleAfterHours(v)} className={toggleCls(v.afterHoursService)} aria-pressed={v.afterHoursService}><span className={knobCls(v.afterHoursService)} /></button>
                        </div>
                        <div className="flex items-center gap-2 pt-1.5 border-t border-gray-100">
                          <button type="button" onClick={() => startEdit(v)} className="text-sm font-heading font-semibold text-brand hover:underline">Edit</button>
                          <span className="text-gray-300">·</span>
                          <button type="button" onClick={() => void deactivateVendor(v)} className="text-sm font-heading font-semibold text-amber-700 hover:underline">Deactivate</button>
                          <span className="text-gray-300">·</span>
                          <button type="button" onClick={() => void deleteVendor(v)} className="text-sm font-heading font-semibold text-red-600 hover:underline">Delete</button>
                        </div>
                      </div>
                    </>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
