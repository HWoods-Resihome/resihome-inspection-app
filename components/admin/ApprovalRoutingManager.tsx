/**
 * Approval Routing manager (admin · /admin/flows).
 *
 * Edits the PODs → Regions (PM/Sr.PM) + RM + Director-tier structure that decides
 * who gets @-mentioned on Slack when a rate-card scope goes to pending approval.
 * Users are picked from the W2 agents (owners); the Slack ID auto-fills from the
 * agent's slack_user_id and stays editable. PM and Sr. PM each carry their own NTE
 * ceiling; the RM carries the POD ceiling; above it everyone in the Director tier.
 * Region cards are seeded/added from the region matrix (add/delete). A live
 * preview runs the SAME pure resolver the Slack send will use.
 *
 * The whole section is collapsible, and each POD collapses independently.
 * Backend: /api/admin/approval-routing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type ApprovalRoutingConfig, type ApprovalUser, type PodRouting, type RegionRouting,
  resolveApprovers, emptyApprovalRouting, DEFAULT_POD_CHANNELS,
} from '@/lib/approvalRouting';

interface OwnerOption { name: string; slackId: string; }

const inputCls = 'border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-brand';

function Chevron({ open }: { open: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>;
}

function NteInput({ value, onChange, label }: { value: number | null; onChange: (n: number | null) => void; label?: string }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
      {label}<span className="text-gray-400 text-sm">$</span>
      <input
        type="number" min="0" step="100" inputMode="numeric" placeholder="NTE"
        value={value == null ? '' : String(value)}
        onChange={(e) => { const n = Number(e.target.value); onChange(e.target.value === '' || !Number.isFinite(n) || n <= 0 ? null : n); }}
        className={`${inputCls} w-24 text-right`}
      />
    </label>
  );
}

/** Owner dropdown (W2 agents) + editable Slack ID, with optional NTE. */
function OwnerPicker({
  label, user, owners, onChange, nteValue, onNte,
}: {
  label: string;
  user: ApprovalUser | null | undefined;
  owners: OwnerOption[];
  onChange: (u: ApprovalUser | null) => void;
  nteValue?: number | null;
  onNte?: (n: number | null) => void;
}) {
  const name = user?.name ?? '';
  const slackId = user?.slackId ?? '';
  // Keep a previously-saved name selectable even if they're no longer a W2 agent.
  const options = useMemo(() => {
    const names = owners.map((o) => o.name);
    if (name && !names.includes(name)) names.unshift(name);
    return names;
  }, [owners, name]);

  const pick = (n: string) => {
    if (!n) { onChange(null); return; }
    const o = owners.find((x) => x.name === n);
    onChange({ name: n, slackId: o ? o.slackId : slackId }); // auto-fill Slack ID from the agent
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-heading font-semibold text-gray-500 w-14 shrink-0">{label}</span>
      <select value={name} onChange={(e) => pick(e.target.value)} className={`${inputCls} flex-1 min-w-[150px] max-w-[240px] bg-white`}>
        <option value="">— none —</option>
        {options.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <input
        className={`${inputCls} w-40`} placeholder="Slack ID (U…)" value={slackId}
        onChange={(e) => onChange(name || e.target.value ? { name, slackId: e.target.value } : null)}
        title="Auto-filled from the agent's slack_user_id; override if blank/wrong."
      />
      {onNte && <NteInput value={nteValue ?? null} onChange={onNte} />}
    </div>
  );
}

export function ApprovalRoutingManager() {
  const [config, setConfig] = useState<ApprovalRoutingConfig | null>(null);
  const [availableRegions, setAvailableRegions] = useState<string[]>([]);
  const [owners, setOwners] = useState<OwnerOption[]>([]);
  const [typeFieldFound, setTypeFieldFound] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false);
  const [openPods, setOpenPods] = useState<Record<string, boolean>>({});
  const [addSel, setAddSel] = useState<Record<string, string>>({});
  const [customRegion, setCustomRegion] = useState<Record<string, string>>({});
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
      setOwners(Array.isArray(d.owners) ? d.owners : []);
      setTypeFieldFound(d.typeFieldFound !== false);
    } catch (e: any) { setError(String(e?.message || e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const usedRegions = useMemo(() => {
    const s = new Set<string>();
    for (const p of config?.pods || []) for (const rc of p.regions) s.add(rc.region);
    return s;
  }, [config]);
  const allRegionNames = useMemo(() => Array.from(usedRegions).sort((a, b) => a.localeCompare(b)), [usedRegions]);
  const regionCount = usedRegions.size;

  const dirty = () => setSaved(false);
  const patchPod = (podId: string, fn: (p: PodRouting) => PodRouting) => {
    setConfig((c) => c ? { ...c, pods: c.pods.map((p) => (p.id === podId ? fn(p) : p)) } : c); dirty();
  };
  const patchRegion = (podId: string, region: string, fn: (r: RegionRouting) => RegionRouting) =>
    patchPod(podId, (p) => ({ ...p, regions: p.regions.map((r) => (r.region === region ? fn(r) : r)) }));
  // Add / set / remove a PM or Sr. PM line (key = 'pms' | 'srPms').
  const addUser = (podId: string, region: string, key: 'pms' | 'srPms') =>
    patchRegion(podId, region, (r) => ({ ...r, [key]: [...(r[key] || []), { name: '', slackId: '' }] }));
  const setUser = (podId: string, region: string, key: 'pms' | 'srPms', idx: number, u: ApprovalUser | null) =>
    patchRegion(podId, region, (r) => {
      const list = (r[key] || []).slice();
      if (u == null) list.splice(idx, 1); else list[idx] = u;
      return { ...r, [key]: list };
    });

  const addRegion = (podId: string) => {
    const picked = (customRegion[podId]?.trim()) || addSel[podId] || '';
    if (!picked) return;
    if (usedRegions.has(picked)) { setError(`"${picked}" is already assigned to a POD.`); return; }
    setError(null);
    patchPod(podId, (p) => ({ ...p, regions: [...p.regions, { region: picked, pms: [], pmNte: null, srPms: [], srPmNte: null }] }));
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

  const levelLabel = (lvl: string) => lvl === 'pm' ? 'PM' : lvl === 'sr_pm' ? 'SR / AM' : lvl === 'rm' ? 'RM' : 'Director';

  return (
    <section className="mt-5 border border-gray-200 rounded-xl bg-white">
      {/* Collapsible section header */}
      <button type="button" onClick={() => setSectionOpen((o) => !o)} aria-expanded={sectionOpen}
        className="w-full flex items-center justify-between gap-3 p-4 text-left">
        <div>
          <h2 className="font-heading font-bold text-base text-ink">Approval Routing</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">PODs → Regions (PM / Sr. PM) + RM + Directors with Slack IDs &amp; NTE ceilings — who gets tagged on Slack at pending approval.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-gray-500">
          {!sectionOpen && config && <span className="text-[11px]">{regionCount} region{regionCount === 1 ? '' : 's'}</span>}
          <Chevron open={sectionOpen} />
        </div>
      </button>

      {sectionOpen && (
        <div className="px-4 pb-4 space-y-4">
          {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>}
          {!config ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : (
            <>
              {!typeFieldFound && (
                <div className="text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Couldn’t find the agent “type” field, so the picker lists <strong>all</strong> agents (not just W2). Set <code>HUBSPOT_AGENT_TYPE_PROP</code> to the real property name to filter to W2.
                </div>
              )}

              {/* Director tier */}
              <div className="border border-gray-200 rounded-xl bg-gray-50/60 p-4">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-heading font-bold text-sm text-ink">Director &amp; Above</h3>
                  <span className="text-[11px] text-gray-400">Tagged when an approval exceeds the RM ceiling — everyone here.</span>
                </div>
                <div className="space-y-2 mt-2">
                  {config.directors.length === 0 && <p className="text-[12px] text-gray-400">No directors yet — add at least one as the top-level fallback.</p>}
                  {config.directors.map((u, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <OwnerPicker label={`#${i + 1}`} user={u} owners={owners} onChange={(nu) => setDirector(i, nu)} />
                      <button type="button" onClick={() => setDirector(i, null)} className="text-gray-400 hover:text-rose-600 text-lg leading-none px-1" aria-label="Remove director">×</button>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={addDirector} className="mt-3 text-xs font-heading font-semibold text-brand hover:underline">+ Add director</button>
              </div>

              {/* POD cards (each collapsible) */}
              {config.pods.map((pod) => {
                const unused = availableRegions.filter((r) => !usedRegions.has(r));
                const podOpen = !!openPods[pod.id];
                return (
                  <div key={pod.id} className="border border-gray-200 rounded-xl bg-white overflow-hidden">
                    <button type="button" onClick={() => setOpenPods((m) => ({ ...m, [pod.id]: !m[pod.id] }))} aria-expanded={podOpen}
                      className="w-full flex items-center justify-between gap-3 p-3 text-left bg-gray-50 hover:bg-gray-100">
                      <span className="font-heading font-bold text-sm text-ink">{pod.name} <span className="text-xs font-normal text-gray-400">POD</span></span>
                      <span className="flex items-center gap-2 text-[11px] text-gray-500">
                        {pod.regions.length} region{pod.regions.length === 1 ? '' : 's'}{pod.rm?.name ? ` · RM: ${pod.rm.name}` : ' · no RM'}
                        <Chevron open={podOpen} />
                      </span>
                    </button>

                    {podOpen && (
                      <div className="p-4">
                        {/* Slack channel (name fixed per POD; ID editable, pre-filled) */}
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                          <span className="text-[11px] font-heading font-semibold text-gray-500 w-14 shrink-0">Slack</span>
                          <span className="text-sm text-gray-400 select-none" title="Fixed review channel for this POD">#{DEFAULT_POD_CHANNELS[pod.id]?.channelName || pod.id}</span>
                          <input className={`${inputCls} w-44`} value={pod.channelId}
                            onChange={(e) => patchPod(pod.id, (p) => ({ ...p, channelId: e.target.value }))}
                            placeholder="Channel ID (C…)" title="Slack channel ID this POD posts to" />
                        </div>

                        {/* RM */}
                        <div className="mb-3 pb-3 border-b border-gray-100">
                          <OwnerPicker label="RM" user={pod.rm} owners={owners}
                            onChange={(u) => patchPod(pod.id, (p) => ({ ...p, rm: u }))}
                            nteValue={pod.rmNte} onNte={(n) => patchPod(pod.id, (p) => ({ ...p, rmNte: n }))} />
                        </div>

                        {/* Region cards */}
                        <div className="space-y-2.5">
                          {pod.regions.length === 0 && <p className="text-[12px] text-gray-400">No regions yet — add one below.</p>}
                          {pod.regions.map((rc) => (
                            <div key={rc.region} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-heading font-semibold text-sm text-ink">{rc.region}</span>
                                <button type="button" onClick={() => removeRegion(pod.id, rc.region)} className="text-gray-400 hover:text-rose-600 text-sm font-heading font-semibold" aria-label="Delete region">Delete</button>
                              </div>

                              {/* SR / AM and PM tiers — many users, one ceiling each; all tagged within it.
                                  SR / AM shown first per the region breakdown layout. */}
                              {([{ key: 'srPms', list: rc.srPms, nte: rc.srPmNte, label: 'SR / AM', nteKey: 'srPmNte' }, { key: 'pms', list: rc.pms, nte: rc.pmNte, label: 'PM', nteKey: 'pmNte' }] as const).map((tier) => (
                                <div key={tier.key} className="mt-2 first:mt-0">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-heading font-semibold text-gray-500">{tier.label}</span>
                                    <NteInput label={`${tier.label} NTE`} value={tier.nte}
                                      onChange={(n) => patchRegion(pod.id, rc.region, (r) => ({ ...r, [tier.nteKey]: n }))} />
                                  </div>
                                  <div className="space-y-1 mt-1">
                                    {(tier.list || []).length === 0 && <p className="text-[11px] text-gray-400 pl-1">none</p>}
                                    {(tier.list || []).map((u, i) => (
                                      <div key={i} className="flex items-center gap-2">
                                        <OwnerPicker label={`#${i + 1}`} user={u} owners={owners}
                                          onChange={(nu) => setUser(pod.id, rc.region, tier.key, i, nu)} />
                                        <button type="button" onClick={() => setUser(pod.id, rc.region, tier.key, i, null)} className="text-gray-400 hover:text-rose-600 text-lg leading-none px-1" aria-label={`Remove ${tier.label}`}>×</button>
                                      </div>
                                    ))}
                                  </div>
                                  <button type="button" onClick={() => addUser(pod.id, rc.region, tier.key)} className="mt-1 text-xs font-heading font-semibold text-brand hover:underline">+ Add {tier.label}</button>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>

                        {/* Add region */}
                        <div className="flex flex-wrap items-center gap-2 mt-3">
                          <select value={addSel[pod.id] || ''} onChange={(e) => setAddSel((m) => ({ ...m, [pod.id]: e.target.value }))} className={`${inputCls} max-w-[220px] bg-white`}>
                            <option value="">{unused.length ? 'Add a region…' : '(all regions assigned)'}</option>
                            {unused.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <span className="text-[11px] text-gray-400">or</span>
                          <input className={`${inputCls} w-44`} placeholder="Custom region name" value={customRegion[pod.id] || ''} onChange={(e) => setCustomRegion((m) => ({ ...m, [pod.id]: e.target.value }))} />
                          <button type="button" onClick={() => addRegion(pod.id)} className="text-xs font-heading font-semibold text-white bg-brand hover:opacity-90 rounded-lg px-3 py-1.5">+ Add region</button>
                        </div>
                      </div>
                    )}
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
                    <select value={pvRegion} onChange={(e) => setPvRegion(e.target.value)} className={`${inputCls} block mt-0.5 max-w-[220px] bg-white`}>
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
                      <span className="ml-2 text-[11px] uppercase tracking-wide text-gray-400">{levelLabel(preview.level)}</span>
                    </div>
                    <div className="text-[12px] text-gray-500 mt-0.5">
                      {preview.channelName ? <>Posts to <span className="font-heading font-semibold">#{preview.channelName}</span>{preview.channelId ? ` (${preview.channelId})` : ''}. </> : null}
                      {preview.reason}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
