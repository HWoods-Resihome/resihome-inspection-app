import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useAppDialog } from '@/components/AppDialog';
import { useRouter } from 'next/router';
import type {
  Property, TemplateType, HubSpotUser,
} from '@/lib/types';
import { Combobox } from '@/components/Combobox';

type Stage = 'setup' | 'loading_questions' | 'error';

// Today's date in the user's LOCAL timezone, formatted YYYY-MM-DD
// (input[type=date] only accepts date-only format). We avoid toISOString()
// here because that's UTC and would roll over to "tomorrow" for users in
// the evening in US timezones.
function todayLocalStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Templates are grouped into sections (Turn / PM / 1099 / QC) shown as headers
// in the dropdown; the bare template name sits under its section.
const TEMPLATE_OPTIONS: { value: TemplateType; label: string; sublabel: string; group: string }[] = [
  { value: 'pm_scope_rate_card',                        group: 'Turn', label: 'Scope Rate Card',                 sublabel: 'Priced line items; tenant chargebacks + vendor bids' },
  { value: 'pm_turn_reinspect_qc',                      group: 'Turn', label: 'Turn Re-Inspect QC',              sublabel: 'Validate vendor work against a Scope Rate Card' },
  { value: 'pm_community_inspection',                   group: 'PM',   label: 'Community / Visit Inspection',    sublabel: 'Community grounds, amenities, signage' },
  { value: 'pm_vacancy_occupancy_check',                group: 'PM',   label: 'Vacancy / Occupancy Check',       sublabel: 'Quick visit to confirm vacancy/security' },
  { value: 'leasing_agent_1099_property_inspection',    group: '1099', label: 'Leasing Agent Property Inspection', sublabel: 'Pre-tour assessment by leasing agent' },
  { value: 'qc_new_construction_rrqc',                  group: 'QC',   label: 'New Construction RRQC',           sublabel: 'Rent-ready QC for new construction' },
];

export default function NewInspection() {
  const dialog = useAppDialog();
  const router = useRouter();

  // Setup stage state. Properties are searched server-side (the portal can hold
  // 15k+, far past what we can pre-load), so `properties` holds only the current
  // result page. `propertyQuery` is the debounced search term from the picker,
  // and `selectedProp` pins the chosen property so its label/bed/bath survive
  // even after the result list changes under it.
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyQuery, setPropertyQuery] = useState('');
  const [selectedProp, setSelectedProp] = useState<Property | null>(null);
  // True only until the first results land — drives the picker's disabled
  // "Loading…" state. Per-keystroke refetches must NOT disable the input.
  const [propertiesLoading, setPropertiesLoading] = useState(true);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);

  // Logged-in user is the inspector. Fetched once from /api/auth/me.
  const [sessionUser, setSessionUser] = useState<{ userId: string; email: string; name: string } | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const [selectedTemplate, setSelectedTemplate] = useState<TemplateType | ''>('');
  const [selectedPropertyId, setSelectedPropertyId] = useState('');
  const [bedrooms, setBedrooms] = useState<number | null>(null);
  const [bathrooms, setBathrooms] = useState<number | null>(null);

  // QC Turn Re-Inspect: the source Scope Rate Card inspection being validated.
  // Only relevant when selectedTemplate === 'pm_turn_reinspect_qc'.
  const [sourceOptions, setSourceOptions] = useState<
    Array<{ recordId: string; inspectionName: string; status: string; submittedAt: string | null }>
  >([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const isQcTemplate = selectedTemplate === 'pm_turn_reinspect_qc';

  // Scheduling state. The "Scheduled Date" field is always visible and defaults
  // to today. Picking a future date turns the form into a scheduled (assignable)
  // inspection: the action button becomes "Schedule & Save" and an inspector
  // dropdown appears. Today (or past) = jump straight into the inspection.
  const [scheduledDate, setScheduledDate] = useState<string>(todayLocalStr());
  const [scheduledInspectorEmail, setScheduledInspectorEmail] = useState<string>('');
  const [users, setUsers] = useState<HubSpotUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [schedulingBusy, setSchedulingBusy] = useState(false);

  const [stage, setStage] = useState<Stage>('setup');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Search properties server-side as the (debounced) query changes. Runs once on
  // mount with an empty term for the default page, then again per search. We
  // don't toggle `propertiesLoading` on refetch so the picker input stays usable
  // while typing; only the initial load shows the disabled "Loading…" state.
  useEffect(() => {
    let cancelled = false;
    const url = '/api/properties' + (propertyQuery ? `?q=${encodeURIComponent(propertyQuery)}` : '');
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setPropertiesError(data.error);
        else { setPropertiesError(null); setProperties(data.properties || []); }
      })
      .catch((e) => { if (!cancelled) setPropertiesError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setPropertiesLoading(false); });
    return () => { cancelled = true; };
  }, [propertyQuery]);

  // Session (inspector identity) — loaded once.
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) setSessionUser(data.user);
      })
      .catch(() => {})
      .finally(() => setSessionLoading(false));
  }, []);

  // Pin the chosen property the moment it appears in a result page, so it
  // survives later searches that no longer include it (server returns only the
  // current match page). This keeps the selected label, bed/bath, and address
  // snapshot stable.
  useEffect(() => {
    if (!selectedPropertyId) { setSelectedProp(null); return; }
    const p = properties.find((x) => x.recordId === selectedPropertyId);
    if (p) setSelectedProp(p);
  }, [selectedPropertyId, properties]);

  // Dependent bed/bath: populate from the pinned property when it changes.
  useEffect(() => {
    if (!selectedProp) {
      setBedrooms(null);
      setBathrooms(null);
      return;
    }
    setBedrooms(selectedProp.bedrooms ?? null);
    setBathrooms(selectedProp.bathrooms ?? null);
  }, [selectedProp]);

  const selectedProperty = selectedProp || undefined;

  // Build the address snapshot stored on the inspection. We compose it from
  // the property's structured fields (street, city, state, zip) so the zip is
  // ALWAYS included — relying on the property's freeform `name` was
  // inconsistent (some names omit the zip). Falls back to name, then a
  // placeholder, if structured fields are missing.
  const addressSnapshot = useMemo(() => {
    const p = selectedProperty;
    if (!p) return selectedPropertyId ? `(Property ${selectedPropertyId})` : '';
    const composed = [p.address, p.city, p.state, p.zip]
      .map((s) => (s || '').trim())
      .filter(Boolean)
      .join(', ');
    return composed || p.name || `(Property ${selectedPropertyId})`;
  }, [selectedProperty, selectedPropertyId]);

  const propertyOptions = useMemo(() => {
    // Always include the pinned selection so its label renders even when it's
    // not in the current search page.
    const list = [...properties];
    if (selectedProp && !list.some((p) => p.recordId === selectedProp.recordId)) {
      list.unshift(selectedProp);
    }
    return list.map((p) => {
      const loc = [p.city, p.state].filter(Boolean).join(', ');
      // Show status as subtext so the inspector can confirm they picked the
      // right property (e.g. "Austin, TX • Active").
      const sublabel = [loc, p.status].filter(Boolean).join(' • ') || undefined;
      return { value: p.recordId, label: p.name, sublabel };
    });
  }, [properties, selectedProp]);

  // When QC template + a property are selected, load that property's
  // submitted/completed Scope Rate Card inspections for the dependent
  // dropdown. Default to the most recently submitted (first in the list).
  useEffect(() => {
    if (!isQcTemplate || !selectedPropertyId) {
      setSourceOptions([]);
      setSelectedSourceId('');
      setSourceError(null);
      return;
    }
    let cancelled = false;
    setSourceLoading(true);
    setSourceError(null);
    fetch(`/api/properties/${selectedPropertyId}/rate-card-inspections`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancelled) return;
        const opts = d.options || [];
        setSourceOptions(opts);
        // Default to most recent (list is already sorted desc by submittedAt)
        setSelectedSourceId(opts.length > 0 ? opts[0].recordId : '');
        if (opts.length === 0) {
          setSourceError('No submitted Scope Rate Card inspections found for this property.');
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setSourceError(`Could not load source inspections: ${e.message || e}`);
        setSourceOptions([]);
        setSelectedSourceId('');
      })
      .finally(() => { if (!cancelled) setSourceLoading(false); });
    return () => { cancelled = true; };
  }, [isQcTemplate, selectedPropertyId]);
  const templateOptions = useMemo(
    () => TEMPLATE_OPTIONS.map((t) => ({ value: t.value, label: t.label, sublabel: t.sublabel, group: t.group })),
    []
  );

  const setupReady = !!selectedTemplate
    && !!selectedPropertyId
    && !!sessionUser
    && bedrooms != null
    && bathrooms != null
    // QC requires a source Scope Rate Card inspection to validate.
    && (!isQcTemplate || !!selectedSourceId);

  // A future scheduled date (vs. today, in local time) means we save a
  // Scheduled inspection and assign it, rather than starting it now.
  const todayStr = todayLocalStr();
  const isFuture = !!scheduledDate && scheduledDate > todayStr;

  async function handleBegin() {
    if (!setupReady) {
      void dialog.alert('Please complete every field before beginning.');
      return;
    }
    setStage('loading_questions'); // shows a loading state while we create+navigate
    try {
      const body = {
        templateType: selectedTemplate,
        propertyRecordId: selectedPropertyId,
        propertyAddressSnapshot: addressSnapshot,
        inspectorName: sessionUser?.name || '',
        inspectorEmail: sessionUser?.email,
        bedrooms,
        bathrooms,
        ...(isQcTemplate ? { sourceRateCardId: selectedSourceId } : {}),
      };
      const r = await fetch('/api/inspections/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);

      // Hand off to the dynamic page, which will load the (empty) inspection and render the form
      router.replace(`/inspection/${data.inspectionId}`);
    } catch (e: any) {
      setErrorMsg(String(e.message || e));
      setStage('error');
    }
  }

  // When a future date is picked, lazy-load the inspector list (once) and
  // default the assignee to the current user.
  useEffect(() => {
    if (!isFuture) return;
    if (!scheduledInspectorEmail && sessionUser?.email) {
      setScheduledInspectorEmail(sessionUser.email);
    }
    if (users.length === 0 && !usersLoading) {
      setUsersLoading(true);
      fetch('/api/users')
        .then((r) => r.json())
        .then((data) => { if (!data.error) setUsers(data.users || []); })
        .catch((e) => console.error('Failed to load users for scheduling:', e))
        .finally(() => setUsersLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFuture, sessionUser]);

  // Confirm the scheduled inspection: create the record, then go back home.
  async function handleConfirmSchedule() {
    if (!setupReady) return;
    if (!scheduledDate) {
      void dialog.alert('Please pick a scheduled date.');
      return;
    }
    // Resolve the inspector: lookup by email in the users list; fall back to current user
    const picked = users.find((u) => u.email === scheduledInspectorEmail);
    const inspectorName = picked?.fullName || sessionUser?.name || '';
    const inspectorEmail = picked?.email || scheduledInspectorEmail || sessionUser?.email || '';

    setSchedulingBusy(true);
    try {
      const body = {
        templateType: selectedTemplate,
        propertyRecordId: selectedPropertyId,
        propertyAddressSnapshot: addressSnapshot,
        inspectorName,
        inspectorEmail,
        bedrooms,
        bathrooms,
        scheduledDate,
        ...(isQcTemplate ? { sourceRateCardId: selectedSourceId } : {}),
      };
      const r = await fetch('/api/inspections/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
      // Back to home with a hint so the homepage refetches after HubSpot's
      // search index catches up (it can lag a second or two for fresh creates).
      router.push('/?just_scheduled=1');
    } catch (e: any) {
      void dialog.alert(`Could not schedule inspection: ${e.message || e}`);
      setSchedulingBusy(false);
    }
  }

  if (stage === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-white">
        <div className="max-w-md bg-white p-8 rounded-2xl shadow border-2 border-brand">
          <h2 className="text-xl font-heading font-bold text-brand mb-3">Something went wrong</h2>
          <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto whitespace-pre-wrap text-ink">{errorMsg}</pre>
          <button
            onClick={() => { setErrorMsg(null); setStage('setup'); }}
            className="mt-4 w-full bg-ink hover:bg-gray-800 text-white py-2.5 px-4 rounded-lg font-heading font-semibold"
          >
            Start over
          </button>
        </div>
      </div>
    );
  }

  if (stage === 'loading_questions') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-white">
        <div className="text-center">
          <div className="inline-block w-14 h-14 border-4 border-brand border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-gray-700 font-heading font-semibold">Creating inspection...</p>
        </div>
      </div>
    );
  }

  // Note: 'form' stage is no longer used here. The form now lives on
  // /inspection/[id]; handleBegin() redirects there after creating the
  // Scheduled record. The submit/done states below remain for the (rare)
  // case where the user lands on a stage state during transition.

  // Setup stage
  return (
    <>
      <Head>
        <title>New Inspection</title>
      </Head>
      <main className="min-h-screen p-4 sm:p-6 bg-white">
        <div className="max-w-xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <Link href="/" className="text-sm text-gray-500 hover:text-ink font-heading">&larr; Home</Link>
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            <h1 className="text-2xl font-heading font-bold mb-1">New Inspection</h1>
            <p className="text-sm text-gray-500 mb-6 font-heading uppercase tracking-wider">
              Pick a template and property to begin
            </p>

            <div className="space-y-5">
              {/* Inspection Type / Template */}
              <div>
                <label htmlFor="template-cb" className="block text-sm font-heading font-semibold text-ink mb-1.5">
                  Inspection Type
                </label>
                <Combobox
                  id="template-cb"
                  options={templateOptions}
                  value={selectedTemplate}
                  onChange={(v) => setSelectedTemplate(v as TemplateType)}
                  placeholder="Select template"
                  emptyLabel="No template matches"
                />
              </div>

              {/* Property */}
              <div>
                <label htmlFor="property-cb" className="block text-sm font-heading font-semibold text-ink mb-1.5">
                  Property
                </label>
                <Combobox
                  id="property-cb"
                  options={propertyOptions}
                  value={selectedPropertyId}
                  onChange={setSelectedPropertyId}
                  onQueryChange={setPropertyQuery}
                  placeholder={propertiesLoading ? 'Loading properties...' : 'Search by address, name, or zip'}
                  loading={propertiesLoading}
                  error={propertiesError}
                  emptyLabel={propertyQuery ? 'No matching properties' : 'Type to search properties'}
                />
              </div>

              {/* QC Turn Re-Inspect: dependent source-inspection picker.
                  Only shows when the QC template is selected. Lists the
                  property's submitted/completed Scope Rate Card inspections,
                  defaulting to the most recent. */}
              {isQcTemplate && (
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1.5">
                    Scope Rate Card to Validate
                  </label>
                  {!selectedPropertyId ? (
                    <div className="text-sm text-gray-400 border border-gray-200 bg-gray-50 rounded-lg px-3 py-2.5">
                      Select a property first
                    </div>
                  ) : sourceLoading ? (
                    <div className="text-sm text-gray-400 border border-gray-200 bg-gray-50 rounded-lg px-3 py-2.5">
                      Loading inspections…
                    </div>
                  ) : sourceOptions.length === 0 ? (
                    <div className="text-sm text-amber-700 border border-amber-200 bg-amber-50 rounded-lg px-3 py-2.5">
                      {sourceError || 'No submitted Scope Rate Card inspections for this property.'}
                    </div>
                  ) : (
                    <>
                      <Combobox
                        id="source-rc-cb"
                        options={sourceOptions.map((o) => ({
                          value: o.recordId,
                          label: o.inspectionName,
                          sublabel: [
                            o.status,
                            o.submittedAt ? new Date(/^\d+$/.test(o.submittedAt) ? Number(o.submittedAt) : o.submittedAt).toLocaleDateString() : null,
                          ].filter(Boolean).join(' · ') || undefined,
                        }))}
                        value={selectedSourceId}
                        onChange={setSelectedSourceId}
                        placeholder="Select the inspection to validate"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Defaults to the most recently submitted. The QC will copy this
                        inspection's line items for pass/fail validation.
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* Dependent bed/bath */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1.5">Bedrooms</label>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={bedrooms ?? ''}
                    onChange={(e) => setBedrooms(e.target.value === '' ? null : Number(e.target.value))}
                    placeholder={selectedPropertyId ? '0' : 'Select property first'}
                    disabled={!selectedPropertyId}
                    className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1.5">Bathrooms</label>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    step={0.5}
                    value={bathrooms ?? ''}
                    onChange={(e) => setBathrooms(e.target.value === '' ? null : Number(e.target.value))}
                    placeholder={selectedPropertyId ? '0' : 'Select property first'}
                    disabled={!selectedPropertyId}
                    className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </div>
              </div>
              {selectedPropertyId && (bedrooms == null || bathrooms == null) && (
                <p className="text-xs text-gray-500 -mt-2">
                  Bedroom/bathroom counts weren&apos;t found on the property record. Please enter them manually.
                </p>
              )}

              {/* Scheduled Date \u2014 always visible, defaults to today. Picking a
                  future date turns this into a scheduled (assignable) inspection. */}
              <div>
                <label htmlFor="sched-date" className="block text-sm font-heading font-semibold text-ink mb-1.5">
                  Scheduled Date
                </label>
                <input
                  id="sched-date"
                  type="date"
                  min={todayStr}
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  onClick={(e) => {
                    // Open the native date picker on tap anywhere in the input,
                    // not just the tiny calendar icon. showPicker() needs a user
                    // gesture (Chrome 99+, Safari 16+, Firefox 101+).
                    const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                    try { el.showPicker?.(); } catch { /* fallback: native behavior */ }
                  }}
                  className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white cursor-pointer"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {isFuture
                    ? 'Future date \u2014 saved as a Scheduled inspection and assigned below.'
                    : 'Today \u2014 you\u2019ll go straight into the inspection.'}
                </p>
              </div>

              {/* Inspector. Today: locked to the signed-in user. Future date:
                  becomes an assignable dropdown. */}
              <div>
                <label className="block text-sm font-heading font-semibold text-ink mb-1.5">
                  {isFuture ? 'Assign to Inspector' : 'Inspector'}
                </label>
                {isFuture ? (
                  usersLoading ? (
                    <div className="text-sm text-gray-500 border border-gray-200 bg-gray-50 rounded-lg px-3 py-2.5">Loading inspectors&hellip;</div>
                  ) : users.length === 0 ? (
                    <div className="text-sm text-gray-600 border border-gray-200 bg-gray-50 rounded-lg px-3 py-2.5">
                      Couldn&apos;t load the inspector list. This will be assigned to you ({sessionUser?.name}).
                    </div>
                  ) : (
                    <select
                      value={scheduledInspectorEmail}
                      onChange={(e) => setScheduledInspectorEmail(e.target.value)}
                      className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white"
                    >
                      {users.map((u) => (
                        <option key={u.id} value={u.email}>
                          {u.fullName} {u.email === sessionUser?.email ? '(me)' : ''}
                        </option>
                      ))}
                    </select>
                  )
                ) : (
                  <>
                    <div className="flex items-center w-full border border-gray-200 bg-gray-50 rounded-lg px-3 py-2.5">
                      {sessionLoading ? (
                        <span className="text-sm text-gray-400">Loading...</span>
                      ) : sessionUser ? (
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-heading font-semibold text-ink truncate">
                            {sessionUser.name}
                          </div>
                          <div className="text-xs text-gray-500 truncate">{sessionUser.email}</div>
                        </div>
                      ) : (
                        <span className="text-sm text-brand">Not signed in</span>
                      )}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                           className="text-gray-400 ml-2 shrink-0">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Signed in as the inspector. <button type="button" onClick={async () => {
                        try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
                        router.replace('/login');
                      }} className="text-brand underline">Sign out</button> to change.
                    </p>
                  </>
                )}
              </div>

              {/* Single action button: Begin now (today) or Schedule & Save (future). */}
              <button
                onClick={isFuture ? handleConfirmSchedule : handleBegin}
                disabled={!setupReady || schedulingBusy || (isFuture && !scheduledDate)}
                className="w-full bg-brand hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-heading font-semibold py-3.5 px-3 rounded-lg transition active:scale-[0.98] mt-2"
              >
                {schedulingBusy ? 'Scheduling\u2026' : (isFuture ? 'Schedule & Save' : 'Begin Inspection')}
              </button>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
