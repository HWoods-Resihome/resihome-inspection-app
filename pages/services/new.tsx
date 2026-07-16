import { useEffect, useMemo, useState } from 'react';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { isViewingAsVendor } from '@/lib/services/viewAs';
import { ListPicker } from '@/components/ListPicker';
import { PageHeader } from '@/components/PageHeader';
import { FIELD_LABEL, FIELD_INPUT, FIELD_TRIGGER, CARD, primaryBtn } from '@/components/formStyles';
import { AutoGrowTextarea } from '@/components/AutoGrowTextarea';
import { Combobox } from '@/components/Combobox';
import { DatePicker } from '@/components/DatePicker';
import { PriceField } from '@/components/PriceField';
import { descriptionFor, defaultRateFor, mergeWorktypes, type CustomWorktypeDef } from '@/lib/services/worktypes';
import { sanitizeNum, clientFrom } from '@/lib/services/pricing';
import { fmtMDY } from '@/lib/services/sampleData';
import { syncAllProperties, searchCachedProperties } from '@/lib/propertyCache';
import { readServiceTaxonomy } from '@/lib/hubspot';

interface PropOpt { value: string; label: string; sublabel: string; address: string; locality: string; region: string; }

const DEFAULT_MARKUP = '20';

// Internal users (@resihome / @resicap / …) only; also flag+admin gated.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok || !isInternalEmail(session?.email) || isViewingAsVendor(ctx.req)) return { redirect: { destination: '/services', permanent: false } };
  const taxonomy = await readServiceTaxonomy().catch(() => null);
  return { props: { servicesTaxonomy: (taxonomy as CustomWorktypeDef[] | null) || null } };
};

export default function NewService({ servicesTaxonomy }: { servicesTaxonomy: CustomWorktypeDef[] | null }) {
  const [worktype, setWorktype] = useState('');
  const [subtype, setSubtype] = useState('');
  const [description, setDescription] = useState('');
  const [vendorCost, setVendorCost] = useState('');
  const [markupPct, setMarkupPct] = useState(DEFAULT_MARKUP);
  const [clientCost, setClientCost] = useState('');
  const [scope, setScope] = useState<'property' | 'community'>('property');
  const [target, setTarget] = useState('');
  // Live property search (server-backed) + selected snapshot; live community list.
  const [propOptions, setPropOptions] = useState<PropOpt[]>([]);
  const [propLoading, setPropLoading] = useState(false);
  const [selectedProp, setSelectedProp] = useState<PropOpt | null>(null);
  const [communities, setCommunities] = useState<{ id: string; name: string; units: number }[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [vendor, setVendor] = useState('');
  // Live assignable vendors from the approved Companies list.
  const [vendorNames, setVendorNames] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/services/vendors').then((r) => r.json()).then((d) => {
      if (!alive || !Array.isArray(d?.vendors)) return;
      const names = d.vendors.map((v: any) => String(v.name)).filter(Boolean);
      setVendorNames(names);
      setVendor((cur) => cur || names[0] || '');
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const [created, setCreated] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

  const handleCreate = async () => {
    setSubmitting(true); setCreateError('');
    try {
      const r = await fetch('/api/services/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          worktype, subtype, description, scope, target, dueDate, vendor, vendorCost, markupPct, clientCost,
          // Real snapshot fields resolved client-side (no sample lookup server-side).
          propertyId: scope === 'property' ? target : '',
          communityName: scope === 'community' ? target : '',
          address: scope === 'property' ? (selectedProp?.address || '') : target,
          locality: scope === 'property' ? (selectedProp?.locality || '') : '',
          region: scope === 'property' ? (selectedProp?.region || '') : '',
        }),
      });
      const d = await r.json();
      if (!r.ok) { setCreateError(d.error || 'Could not create the service.'); return; }
      setCreatedId(d.id ? String(d.id) : null);   // present when live; d.preview true pre-go-live
      setCreated(true);
    } catch {
      setCreateError('Couldn’t reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // Prefill the editable description + pricing defaults from the worktype+subtype
  // whenever either changes (mirrors Section 1 of the Rules Engine).
  useEffect(() => {
    if (!worktype) { setDescription(''); setVendorCost(''); setMarkupPct(DEFAULT_MARKUP); setClientCost(''); return; }
    setDescription(descriptionFor(worktype, subtype));
    const rate = defaultRateFor(worktype, subtype);
    const vc = rate != null ? String(rate) : '';
    setVendorCost(vc); setMarkupPct(DEFAULT_MARKUP); setClientCost(clientFrom(vc, DEFAULT_MARKUP));
  }, [worktype, subtype]);

  // Cross-computed pricing: editing vendor cost or markup recomputes client cost;
  // editing client cost back-solves the markup (so all three stay editable & consistent).
  const onVendorCost = (v: string) => { const vc = sanitizeNum(v); setVendorCost(vc); setClientCost(clientFrom(vc, markupPct)); };
  const onMarkup = (v: string) => { const mk = sanitizeNum(v); setMarkupPct(mk); setClientCost(clientFrom(vendorCost, mk)); };
  const onClientCost = (v: string) => {
    const cc = sanitizeNum(v); setClientCost(cc);
    const vc = parseFloat(vendorCost || '0');
    if (vc > 0) setMarkupPct((((parseFloat(cc || '0') / vc) - 1) * 100).toFixed(2));
  };

  // Live community list (stays current as communities are added in HubSpot).
  useEffect(() => {
    let alive = true;
    fetch('/api/services/communities').then((r) => r.json()).then((d) => { if (alive && d?.communities) setCommunities(d.communities); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Property search runs against the SAME device-cached full property list the
  // inspection picker uses (IndexedDB via propertyCache) — so typing filters
  // INSTANTLY, with no per-keystroke server round-trip / "Loading…" flicker.
  const searchProps = (q: string) => {
    searchCachedProperties(q, 50).then((rows) => {
      setPropOptions(rows.map((p) => {
        const locality = [p.city, p.state, p.zip].filter(Boolean).join(', ');
        // Mirror the inspection picker: full address as the label, "Region ·
        // Property Status" as the sublabel.
        const fullAddress = [p.address || p.name, p.city, p.state, p.zip].filter(Boolean).join(', ');
        const sub = [p.region, p.status].filter(Boolean).join(' · ');
        return { value: String(p.recordId), label: fullAddress || p.name || `(Property ${p.recordId})`, sublabel: sub, address: p.address || p.name || '', locality, region: p.region || '' };
      }));
    }).catch(() => {});
  };
  // Warm the cache once (no-op if the inspection side already synced it today),
  // then paint the first page. Only the initial sync shows a loading state.
  useEffect(() => {
    let alive = true;
    setPropLoading(true);
    (async () => {
      try { await syncAllProperties(); } catch { /* offline / partial — search what's cached */ }
      if (!alive) return;
      searchProps('');
      setPropLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Built-in taxonomy merged with the admin's custom work types / subtypes.
  const defs = useMemo(() => mergeWorktypes(servicesTaxonomy), [servicesTaxonomy]);
  const subsOf = (wt: string) => defs.find((w) => w.id === wt)?.subtypes || [];
  const wtLabelOf = (wt: string) => defs.find((w) => w.id === wt)?.label || wt;
  const subLabelOf = (wt: string, st: string) => subsOf(wt).find((s) => s.id === st)?.label || st;
  const worktypeOptions = useMemo(() => defs.filter((w) => w.scopes.includes(scope)).map((w) => ({ value: w.id, label: w.label })), [defs, scope]);
  const subtypeOptions = useMemo(() => subsOf(worktype).map((s) => ({ value: s.id, label: s.label })), [defs, worktype]);
  const communityOptions = useMemo(() => communities.map((c) => ({ value: c.name, label: c.name, sublabel: c.units ? `${c.units} units` : undefined })), [communities]);
  const vendorOptions = vendorNames.map((v) => ({ value: v, label: v }));

  const lbl = FIELD_LABEL;
  const trig = FIELD_TRIGGER;
  const ready = !!worktype && !!subtype && !!target && !!dueDate && !!vendor;
  const targetLabel = scope === 'property' ? (selectedProp?.address || '') : target;
  // Full address (property) or community name — shown on the confirmation.
  const confirmTarget = scope === 'property'
    ? [selectedProp?.address, selectedProp?.locality].filter(Boolean).join(', ')
    : target;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header — the shared centered pink header (logo + title). */}
      <PageHeader title="New Service" backHref="/services" backLabel="Back to Services" />

      <main className="max-w-2xl mx-auto w-full px-4 py-4 flex-1">
        {created ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Service Created</div>
            <p className="text-sm text-ink mt-1 font-semibold">{wtLabelOf(worktype)} · {subLabelOf(worktype, subtype)}</p>
            <p className="text-sm text-gray-500">{confirmTarget} · Due {fmtMDY(dueDate)}</p>
            <div className={`grid ${createdId ? 'grid-cols-3' : 'grid-cols-2'} gap-2 mt-4`}>
              {/* Open the new record directly (a by-id fetch, available immediately —
                  the list search can lag a few seconds behind a fresh create). */}
              {createdId && (
                <a href={`/services/${encodeURIComponent(createdId)}`} className="bg-brand text-white rounded-xl px-3 py-2 font-heading font-bold text-[13px] text-center leading-tight grid place-items-center">Open Service</a>
              )}
              <button onClick={() => { setCreated(false); setCreatedId(null); setWorktype(''); setSubtype(''); setTarget(''); setSelectedProp(null); setDueDate(''); setVendor(vendorNames[0] || ''); }} className="border border-gray-300 bg-white rounded-xl px-3 py-2 font-heading font-bold text-[13px] text-center leading-tight">Create Another</button>
              {/* Hard navigation so the Services list re-runs its server fetch. */}
              <a href="/services" className={`rounded-xl px-3 py-2 font-heading font-bold text-[13px] text-center leading-tight grid place-items-center ${createdId ? 'border border-gray-300 bg-white text-ink' : 'bg-brand text-white'}`}>Back to Services</a>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-4">
              {/* 1 — Work type + subtype */}
              <div>
                <label className={lbl}>Work Type</label>
                <ListPicker value={worktype} options={worktypeOptions} onChange={(v) => { setWorktype(v); setSubtype(subsOf(v)[0]?.id || ''); }} ariaLabel="Select a work type" placeholder="Select a work type…" className={trig} />
              </div>
              <div>
                <label className={lbl}>Subtype</label>
                <ListPicker value={subtype} options={subtypeOptions} onChange={setSubtype} ariaLabel="Select a subtype" placeholder="Select a subtype…" className={trig} />
              </div>

              {/* Description — pre-filled from the work type + subtype default; editable (blank until a work type is chosen). */}
              <div>
                <label className={lbl}>Service Description</label>
                <AutoGrowTextarea value={description} onChange={(e) => setDescription(e.target.value)} minPx={64}
                  className={FIELD_INPUT} />
              </div>

              {/* Cost Detail — matches the Rules Engine section. */}
              <div className="border-t border-gray-100 pt-4">
                <label className={lbl}>Cost Detail</label>
                <div className="flex flex-nowrap items-end justify-center gap-4 sm:justify-start">
                  <PriceField label="Vendor Cost" adorn="$" minDecimals={2} colClass="shrink-0 w-24" value={vendorCost} onChange={onVendorCost} />
                  <PriceField label="Markup %" adorn="%" side="right" minDecimals={1} colClass="shrink-0 w-24" value={markupPct} onChange={onMarkup} />
                  <PriceField label="Client Cost" adorn="$" highlight minDecimals={2} colClass="shrink-0 w-24" value={clientCost} onChange={onClientCost} />
                </div>
              </div>

              {/* 2 — Coverage type */}
              <div>
                <label className={lbl}>Coverage Type</label>
                <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
                  <button onClick={() => { setScope('property'); setTarget(''); setSelectedProp(null); }} className={`px-4 py-1.5 rounded-md ${scope === 'property' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600'}`}>Property</button>
                  <button onClick={() => { setScope('community'); setTarget(''); setSelectedProp(null); }} className={`px-4 py-1.5 rounded-md ${scope === 'community' ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-600'}`}>Community</button>
                </div>
              </div>

              {/* 3 — Property address (live search) / Community (live list) */}
              <div>
                <label className={lbl}>{scope === 'property' ? 'Property Address' : 'Community'}</label>
                {scope === 'property' ? (
                  <Combobox value={target} options={propOptions} loading={propLoading}
                    onQueryChange={searchProps}
                    onChange={(v) => { setTarget(v); setSelectedProp(propOptions.find((o) => o.value === v) || null); }}
                    placeholder="Search properties…" emptyLabel="No matching properties" />
                ) : (
                  <ListPicker value={target} options={communityOptions} onChange={setTarget}
                    ariaLabel="Select a community" placeholder="Select a community…" className={trig} />
                )}
              </div>

              {/* 4 — Due date + Vendor */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Due Date</label>
                  <DatePicker value={dueDate} onChange={setDueDate} placeholder="Pick a due date" />
                </div>
                <div>
                  <label className={lbl}>Vendor Assignment</label>
                  <ListPicker value={vendor} options={vendorOptions} onChange={setVendor} ariaLabel="Select a vendor" placeholder="Select a vendor…" className={trig} />
                </div>
              </div>
            </section>

            <button type="button" disabled={!ready || submitting} onClick={handleCreate}
              className={`w-full rounded-2xl py-3.5 font-heading font-bold text-sm ${ready && !submitting ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
              {submitting ? 'Creating…' : `Create Service${targetLabel ? ` — ${targetLabel}` : ''}`}
            </button>
            {createError && <div className="text-center text-xs text-red-600 -mt-2">{createError}</div>}
            {!ready && !createError && <div className="text-center text-xs text-gray-400 -mt-2">Fill in every field to create the service.</div>}
          </div>
        )}
      </main>
    </div>
  );
}
