/**
 * Approval Routing manager (admin · /admin/flows).
 *
 * Edits the PODs → Regions (PM/Sr.PM) + RM + Director-tier structure that decides
 * who gets @-mentioned on Slack when a rate-card scope goes to pending approval.
 * Region cards are seeded/added from the region matrix (availableRegions); add or
 * delete them freely. A live preview runs the SAME pure resolver the Slack send
 * will use, so an admin can sanity-check the routing before saving.
 *
 * Backend: /api/admin/approval-routing (GET config + availableRegions, POST save).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type ApprovalRoutingConfig, type ApprovalUser, type PodRouting, type RegionRouting,
  resolveApprovers, emptyApprovalRouting,
} from '@/lib/approvalRouting';

const inputCls = 'border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-brand';

/** Name + Slack ID pair for one optional/role user. */
function UserInputs({
  label, user, onChange, namePlaceholder,
}: { label: string; user: ApprovalUser | null | undefined; onChange: (u: ApprovalUser | null) => void; namePlaceholder?: string }) {
  const name = user?.name ?? '';
  const slackId = user?.slackId ?? '';
  const set = (n: string, s: string) => onChange(n.trim() === '' && s.trim() === '' ? null : { name: n, slackId: s });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-heading font-semibold text-gray-500 w-14 shrink-0">{label}</span>
      <input className={`${inputCls} flex-1 min-w-[120px]`} placeholder={namePlaceholder || 'Name'} value={name} onChange={(e) => set(e.target.value, slackId)} />
      <input className={`${inputCls} w-40`} placeholder="Slack ID (U…)" value={slackId} onChange={(e) => set(name, e.target.value)} />
    </div>
  );
}

function NteInput({ value, onChange }: { value: number | null; onChange: (n: number | null) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-gray-400 text-sm">$</span>
      <input
        type="number" min="0" step="100" inputMode="numeric" placeholder="NTE"
        value={value == null ? '' : String(value)}
        onChange={(e) => { const n = Number(e.target.value); onChange(e.target.value === '' || !Number.isFinite(n) || n <= 0 ? null : n); }}
        className={`${inputCls} w-28 text-right`}
      />
    </div>
  );
}

export function ApprovalRoutingManager() {
  const [config, setConfig] = useState<ApprovalRoutingConfig | null>(null);
  const [availableRegions, setAvailableRegions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // Per-POD "add region" selection + custom entry.
  const [addSel, setAddSel] = useState<Record<string, string>>({});
  const [customRegion, setCustomRegion] = useState<Record<string, string>>({});
  // Preview tool.
  const [pvRegion, setPvRegion] = useState('');
  const [pvAmount, setPvAmount] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/admin/approval-routing', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); return; }
      setConfig(d.config || emptyApprovalRouting());
      setAvailableRegions(Array.isArray(d.availableRegions) ? d.availableRegions : []);
    } catch (e: any) { setError(String(e?.message || e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Regions already placed under some POD (so the picker can omit them).
  const usedRegions = useMemo(() => {
    const s = new Set<string>();
    for (const p of config?.pods || []) for (const rc of p.regions) s.add(rc.region);
    return s;
  }, [config]);

  // All configured region names (for the preview dropdown).
  const allRegionNames = useMemo(() => Array.from(usedRegions).sort((a, b) => a.localeCompare(b)), [usedRegions]);

  const dirty = () => setSaved(false);
  const patchPod = (podId: string, fn: (p: PodRouting) => PodRouting) => {
    setConfig((c) => c ? { ...c, pods: c.pods.map((p) => (p.id === podId ? fn(p) : p)) } : c);
    dirty();
  };
  const patchRegion = (podId: string, region: string, fn: (r: RegionRouting) => RegionRouting) =>
    patchPod(podId, (p) => ({ ...p, regions: p.regions.map((r) => (r.region === region ? fn(r) : r)) }));

  const addRegion = (podId: string) => {
    const picked = (customRegion[podId]?.trim()) || addSel[podId] || '';
    if (!picked) return;
    if (usedRegions.has(picked)) { setError(`"${picked}" is already assigned to a POD.`); return; }
    setError(null);
    patchPod(podId, (p) => ({ ...p, regions: [...p.regions, { region: picked, pm: null, srPm: null, nte: null }] }));
    setAddSel((m) => ({ ...m, [podId]: '' }));
    setCustomRegion((m) => ({ ...m, [podId]: '' }));
  };
  const removeRegion = (podId: string, region: string) =>
    patchPod(podId, (p) => ({ ...p, regions: p.regions.filter((r) => r.region !== region) }));

  const setDirector = (idx: number, u: ApprovalUser | null) => {
    setConfig((c) => {
      if (!c) return c;
      const next = c.directors.slice();
      if (u == null) next.splice(idx, 1); else next[idx] = u;
      return { ...c, directors: next };
    });
    dirty();
  };
  const addDirector = () => { setConfig((c) => c ? { ...c, directors: [...c.directors, { name: '', slackId: '' }] } : c); dirty(); };

  async function save() {
    if (!config) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const r = await fetch('/api/admin/approval-routing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Save failed'); return; }
      setConfig(d.config || config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  }

  const preview = useMemo(() => {
    if (!config || !pvRegion) return null;
    return resolveApprovers(config, pvRegion, Number(pvAmount) || 0);
  }, [config, pvRegion, pvAmount]);

  if (!config) {
    return <div className="text-sm text-gray-500">{error ? <span className="text-rose-600">{error}</span> : 'Loading…'}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-gray-600 leading-relaxed">
        Who gets tagged on Slack when a rate-card scope hits <strong>pending approval</strong>, by region + dollar amount.
        Within a region&apos;s NTE the <strong>PM / Sr. PM</strong> are tagged (if set, else it falls to the RM); above it the
        <strong> POD RM</strong>; above the RM&apos;s NTE everyone in the <strong>Director</strong> tier.
      </p>

      {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>}

      {/* Director & above tier */}
      <div className="border border-gray-200 rounded-xl bg-white p-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-heading font-bold text-sm text-ink">Director &amp; Above</h3>
          <span className="text-[11px] text-gray-400">Tagged when an approval exceeds the RM ceiling — everyone here.</span>
        </div>
        <div className="space-y-2 mt-2">
          {config.directors.length === 0 && <p className="text-[12px] text-gray-400">No directors yet — add at least one as the top-level fallback.</p>}
          {config.directors.map((u, i) => (
            <div key={i} className="flex items-center gap-2">
              <UserInputs label={`#${i + 1}`} user={u} onChange={(nu) => setDirector(i, nu)} namePlaceholder="Director name" />
              <button type="button" onClick={() => setDirector(i, null)} className="text-gray-400 hover:text-rose-600 text-lg leading-none px-1" aria-label="Remove director">×</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={addDirector} className="mt-3 text-xs font-heading font-semibold text-brand hover:underline">+ Add director</button>
      </div>

      {/* POD cards */}
      {config.pods.map((pod) => {
        const unused = availableRegions.filter((r) => !usedRegions.has(r));
        return (
          <div key={pod.id} className="border border-gray-200 rounded-xl bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3 pb-3 border-b border-gray-100">
              <h3 className="font-heading font-bold text-base text-ink">{pod.name} <span className="text-xs font-normal text-gray-400">POD</span></h3>
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-[260px]"><UserInputs label="RM" user={pod.rm} onChange={(u) => patchPod(pod.id, (p) => ({ ...p, rm: u }))} namePlaceholder="Regional Manager" /></div>
                <NteInput value={pod.rmNte} onChange={(n) => patchPod(pod.id, (p) => ({ ...p, rmNte: n }))} />
              </div>
            </div>

            {/* Region cards */}
            <div className="space-y-2.5">
              {pod.regions.length === 0 && <p className="text-[12px] text-gray-400">No regions yet — add one below.</p>}
              {pod.regions.map((rc) => (
                <div key={rc.region} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-heading font-semibold text-sm text-ink">{rc.region}</span>
                    <div className="flex items-center gap-3">
                      <label className="text-[11px] text-gray-500 flex items-center gap-1.5">Region NTE <NteInput value={rc.nte} onChange={(n) => patchRegion(pod.id, rc.region, (r) => ({ ...r, nte: n }))} /></label>
                      <button type="button" onClick={() => removeRegion(pod.id, rc.region)} className="text-gray-400 hover:text-rose-600 text-sm font-heading font-semibold" aria-label="Delete region">Delete</button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <UserInputs label="PM" user={rc.pm} onChange={(u) => patchRegion(pod.id, rc.region, (r) => ({ ...r, pm: u }))} namePlaceholder="PM (optional)" />
                    <UserInputs label="Sr. PM" user={rc.srPm} onChange={(u) => patchRegion(pod.id, rc.region, (r) => ({ ...r, srPm: u }))} namePlaceholder="Sr. PM (optional)" />
                  </div>
                </div>
              ))}
            </div>

            {/* Add region */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <select
                value={addSel[pod.id] || ''}
                onChange={(e) => setAddSel((m) => ({ ...m, [pod.id]: e.target.value }))}
                className={`${inputCls} max-w-[220px]`}
              >
                <option value="">{unused.length ? 'Add a region…' : '(all regions assigned)'}</option>
                {unused.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <span className="text-[11px] text-gray-400">or</span>
              <input
                className={`${inputCls} w-44`} placeholder="Custom region name"
                value={customRegion[pod.id] || ''}
                onChange={(e) => setCustomRegion((m) => ({ ...m, [pod.id]: e.target.value }))}
              />
              <button type="button" onClick={() => addRegion(pod.id)} className="text-xs font-heading font-semibold text-white bg-brand hover:opacity-90 rounded-lg px-3 py-1.5">+ Add region</button>
            </div>
          </div>
        );
      })}

      {/* Save */}
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={busy}
          className="bg-brand hover:opacity-90 disabled:opacity-50 text-white font-heading font-semibold rounded-lg px-5 py-2 text-sm">
          {busy ? 'Saving…' : 'Save routing'}
        </button>
        {saved && <span className="text-emerald-600 text-sm font-heading font-semibold">Saved ✓</span>}
      </div>

      {/* Live preview */}
      <div className="border border-dashed border-gray-300 rounded-xl bg-gray-50 p-4">
        <h3 className="font-heading font-bold text-sm text-ink mb-2">Preview routing</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-gray-500">Region
            <select value={pvRegion} onChange={(e) => setPvRegion(e.target.value)} className={`${inputCls} block mt-0.5 max-w-[220px]`}>
              <option value="">Select a region…</option>
              {allRegionNames.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-gray-500">Approval amount
            <div className="flex items-center gap-1.5 mt-0.5"><span className="text-gray-400 text-sm">$</span>
              <input type="number" min="0" step="100" inputMode="numeric" value={pvAmount} onChange={(e) => setPvAmount(e.target.value)} placeholder="0" className={`${inputCls} w-32`} />
            </div>
          </label>
        </div>
        {preview && (
          <div className="mt-3 text-sm">
            <div className="font-heading font-semibold text-ink">
              Tags: {preview.users.length ? preview.users.map((u) => u.slackId ? `${u.name} (@${u.slackId})` : `${u.name} (no Slack ID)`).join(', ') : '— nobody configured —'}
              <span className="ml-2 text-[11px] uppercase tracking-wide text-gray-400">{preview.level === 'pm_srpm' ? 'PM / Sr. PM' : preview.level === 'rm' ? 'RM' : 'Director'}</span>
            </div>
            <div className="text-[12px] text-gray-500 mt-0.5">{preview.reason}</div>
          </div>
        )}
      </div>
    </div>
  );
}
