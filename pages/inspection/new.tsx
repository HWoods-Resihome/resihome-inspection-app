import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useAppDialog } from '@/components/AppDialog';
import { useRouter } from 'next/router';
import type {
  Property, TemplateType, HubSpotUser,
} from '@/lib/types';
import { Combobox } from '@/components/Combobox';
import { NumberField } from '@/components/NumberPad';
import { saveCachedProperties, loadCachedMe, saveCachedMe, clearCachedMe, saveCachedInspection, loadCachedQuestions, loadCachedRateCard } from '@/lib/offlineCache';
import { EXTERNAL_TEMPLATE, externalCanCreate1099ForStatus, EXTERNAL_1099_STATUS_BLOCK_MSG } from '@/lib/userAccess';
import { newLocalIds, addPendingInspection, buildSeedPayload } from '@/lib/pendingInspections';
import { syncAllProperties, searchCachedProperties, dropPropertyMemCache } from '@/lib/propertyCache';
import { reportError } from '@/lib/clientErrorReporter';

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
  { value: 'leasing_agent_1099_property_inspection',    group: '1099', label: 'Leasing Agent Inspection',          sublabel: 'Market Ready assessment by leasing agent' },
  { value: 'qc_new_construction_rrqc',                  group: 'QC',   label: 'New Construction RRQC',           sublabel: 'Rent-ready QC for new construction' },
];

// Shape returned by GET /api/communities (kept local to avoid importing the
// server-only hubspot lib into the client bundle).
type CommunityOpt = { id: string; name: string; city: string; state: string; zip: string };
const COMMUNITY_TEMPLATE = 'pm_community_inspection';

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
  // External (1099) users may only create the 1099 template.
  const [isExternal, setIsExternal] = useState(false);

  // String (not TemplateType) so admin-created custom templates are selectable.
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  // Admin-created custom templates (from /api/templates), appended to the picker.
  const [customTemplates, setCustomTemplates] = useState<{ id: string; label: string }[]>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState('');
  const [bedrooms, setBedrooms] = useState<number | null>(null);
  const [bathrooms, setBathrooms] = useState<number | null>(null);
  // Community / Visit inspection: pick a Community (not a property). Local type
  // so we don't pull the server hubspot lib into the client bundle.
  const [communities, setCommunities] = useState<CommunityOpt[]>([]);
  const [communitiesLoading, setCommunitiesLoading] = useState(false);
  const [selectedCommunityId, setSelectedCommunityId] = useState('');

  // QC Turn Re-Inspect: the source Scope Rate Card inspection being validated.
  // Only relevant when selectedTemplate === 'pm_turn_reinspect_qc'.
  const [sourceOptions, setSourceOptions] = useState<
    Array<{ recordId: string; inspectionName: string; status: string; submittedAt: string | null }>
  >([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const isQcTemplate = selectedTemplate === 'pm_turn_reinspect_qc';
  const isCommunityTemplate = selectedTemplate === COMMUNITY_TEMPLATE;
  const selectedCommunity = useMemo(
    () => communities.find((c) => c.id === selectedCommunityId) || null,
    [communities, selectedCommunityId],
  );
  // City, State ZIP line for the chosen community (from the Community object).
  const communityLocationLine = useMemo(() => {
    const c = selectedCommunity;
    if (!c) return '';
    return [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }, [selectedCommunity]);

  // Load communities once the Community / Visit template is chosen.
  useEffect(() => {
    if (!isCommunityTemplate || communities.length || communitiesLoading) return;
    setCommunitiesLoading(true);
    fetch('/api/communities')
      .then((r) => r.json())
      .then((d) => { if (!d.error) setCommunities(d.communities || []); })
      .catch((e) => console.error('Failed to load communities:', e))
      .finally(() => setCommunitiesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCommunityTemplate]);

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
    const q = propertyQuery.trim();
    const PICKER_LIMIT = 100; // comprehensive, vs the server's capped ~50

    // PRIMARY source: the FULL property list (IndexedDB, refreshed ~daily). It's
    // instant, comprehensive (every property — not a capped server page), and
    // works online AND offline. We still hit the server below, but only to MERGE
    // in brand-new properties created since the last daily sync; the cached list
    // is what the picker leads with so you never see a truncated set.
    void searchCachedProperties(q, PICKER_LIMIT).then((rows) => {
      if (cancelled || !rows.length) return;
      setProperties(rows);
      setPropertiesError(null);
      setPropertiesLoading(false);
    });

    // Time the request out so a stalled fetch on weak service fails fast instead
    // of hanging — we keep the cached list visible if it does.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const url = '/api/properties' + (q ? `?q=${encodeURIComponent(q)}` : '');
    fetch(url, { signal: ctrl.signal })
      .then((r) => r.json())
      .then(async (data) => {
        if (cancelled) return;
        if (data.error) {
          // Only surface a server error if we have nothing cached to show.
          const cachedFull = await searchCachedProperties(q, PICKER_LIMIT).catch(() => [] as Property[]);
          if (!cancelled && !cachedFull.length) setPropertiesError(data.error);
          return;
        }
        const server: Property[] = data.properties || [];
        // Merge the comprehensive cached list with any fresh server hit it doesn't
        // yet have (a property created since the last daily sync), deduped by id,
        // name-sorted. The cache leads; the server only ADDS what's missing.
        const cachedFull = await searchCachedProperties(q, PICKER_LIMIT).catch(() => [] as Property[]);
        if (cancelled) return;
        const seen = new Set(cachedFull.map((p) => p.recordId));
        const merged = [...cachedFull, ...server.filter((p) => !seen.has(p.recordId))]
          .sort((a, b) => a.name.localeCompare(b.name));
        const finalList = merged.length ? merged : server;
        setPropertiesError(null);
        setProperties(finalList);
        saveCachedProperties(q, finalList);
      })
      .catch(async () => {
        if (cancelled) return;
        // Weak/no service: the FULL offline cache is already showing (above); only
        // surface guidance if it's empty (cache not downloaded yet).
        const rows = await searchCachedProperties(q, PICKER_LIMIT).catch(() => [] as Property[]);
        if (cancelled) return;
        if (rows.length) {
          setProperties(rows);
          setPropertiesError(null);
        } else {
          const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
          setPropertiesError(offline
            ? 'Offline and the full property list hasn’t downloaded yet — open the app once on a connection so it can cache the list for offline use.'
            : 'Search is slow on this signal — showing saved results. Try again when you have signal.');
        }
      })
      .finally(() => { if (!cancelled) setPropertiesLoading(false); });
    return () => { cancelled = true; clearTimeout(timer); ctrl.abort(); };
  }, [propertyQuery]);

  // Warm/refresh the FULL offline property cache (~15k, IndexedDB) so a later
  // offline start can pick ANY property. Background, online-only, and a no-op
  // when the cache is still fresh (<20h) — see lib/propertyCache. Kicked here AND
  // on the home page; single-flight + freshness-gated, so the double call is safe.
  useEffect(() => {
    const t = setTimeout(() => {
      void syncAllProperties().then((r) => { if (r) dropPropertyMemCache(); });
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  // Session (inspector identity) — loaded once. Hydrate from the cached identity
  // first so an offline open still shows the inspector as signed in (the auth
  // cookie is valid; we just can't reach /api/auth/me to confirm it).
  useEffect(() => {
    const cached = loadCachedMe<{ user: any; isExternal?: boolean }>();
    if (cached?.user) {
      setSessionUser(cached.user);
      if (cached.isExternal) { setIsExternal(true); setSelectedTemplate(EXTERNAL_TEMPLATE); }
      setSessionLoading(false);
    }
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) {
          setSessionUser(data.user);
          saveCachedMe({ user: data.user, isAdmin: !!data.isAdmin, isExternal: !!data.isExternal });
        }
        if (data.isExternal) {
          setIsExternal(true);
          // External users can only create the 1099 template — pre-select it.
          setSelectedTemplate(EXTERNAL_TEMPLATE);
        }
      })
      .catch(() => { /* offline — keep the cached identity */ })
      .finally(() => setSessionLoading(false));
  }, []);

  // Load admin-created custom templates so they appear in the picker.
  useEffect(() => {
    fetch('/api/templates')
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d?.templates)) setCustomTemplates(d.templates); })
      .catch(() => {});
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
      // The address/city/state already show in the main label, so the subtext
      // shows region + status instead — e.g. "Atlanta • Pending MOI/Recap" —
      // to confirm the right property without repeating the location.
      const sublabel = [p.region, p.status].filter(Boolean).join(' • ') || undefined;
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
  const templateOptions = useMemo(() => {
    const builtIn = TEMPLATE_OPTIONS
      // External (1099) users only see the 1099 template.
      .filter((t) => !isExternal || t.value === EXTERNAL_TEMPLATE)
      .map((t) => ({ value: t.value as string, label: t.label, sublabel: t.sublabel, group: t.group }));
    if (isExternal) return builtIn; // 1099 users never get custom templates
    const custom = customTemplates.map((t) => ({ value: t.id, label: t.label, sublabel: 'Custom inspection form', group: 'Custom' }));
    return [...builtIn, ...custom];
  }, [isExternal, customTemplates]);

  // External (1099) users may only START a 1099 walk once the property is in a
  // leasing status (Vacant - Pre-Leasing / On Market). Otherwise the Begin button
  // is disabled and we show why.
  const blockedByPropertyStatus = isExternal
    && selectedTemplate === EXTERNAL_TEMPLATE
    && !!selectedProp
    && !externalCanCreate1099ForStatus(selectedProp.status);

  const setupReady = !!selectedTemplate
    && !!sessionUser
    && !blockedByPropertyStatus
    && (isCommunityTemplate
      // Community / Visit: a community replaces property + bed/bath.
      ? !!selectedCommunityId
      : (!!selectedPropertyId && bedrooms != null && bathrooms != null));
    // QC's source Scope is OPTIONAL — when none is selected the QC starts
    // standalone (empty rooms for after-photos + a final pass/fail verdict).

  // A future scheduled date (vs. today, in local time) means we save a
  // Scheduled inspection and assign it, rather than starting it now.
  const todayStr = todayLocalStr();
  const isFuture = !!scheduledDate && scheduledDate > todayStr;

  // The subject fields of a create body: a property (+ bed/bath) for normal
  // inspections, or a community for Community / Visit. create.ts branches on the
  // template and snapshots the community name as the address.
  function subjectBody() {
    if (isCommunityTemplate) {
      return { communityRecordId: selectedCommunityId, communityName: selectedCommunity?.name || '' };
    }
    return {
      propertyRecordId: selectedPropertyId,
      propertyAddressSnapshot: addressSnapshot,
      bedrooms,
      bathrooms,
    };
  }

  async function handleBegin() {
    if (!setupReady) {
      void dialog.alert('Please complete every field before beginning.');
      return;
    }
    setStage('loading_questions'); // shows a loading state while we create+navigate
    // Already offline → don't even attempt the network (avoids a long timeout);
    // start locally and sync later.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (startLocalInspection()) return;
    }
    const body = {
      templateType: selectedTemplate,
      ...subjectBody(),
      inspectorName: sessionUser?.name || '',
      inspectorEmail: sessionUser?.email,
      ...(isQcTemplate ? { sourceRateCardId: selectedSourceId } : {}),
    };
    let r: Response;
    try {
      // LOW-SERVICE GUARD: in a weak-signal area navigator.onLine is usually TRUE
      // (the radio is associated) but the request hangs. A short timeout turns
      // that stall into an immediate LOCAL start instead of an open-ended spinner
      // — the inspector never feels stuck. 8s is well past a healthy create
      // (~1-2s) but short enough that a dead request falls through fast.
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      r = await fetch('/api/inspections/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(to));
    } catch (netErr: any) {
      // The fetch THREW → genuine network failure OR our timeout aborted it (weak
      // signal). Either way, start LOCALLY so the inspector can work now; the
      // deferred-create driver mints the real HubSpot record + re-keys everything
      // when signal returns.
      if (startLocalInspection()) return;
      setErrorMsg(String(netErr?.message || netErr));
      setStage('error');
      return;
    }
    // We got an HTTP response.
    const data = await r.json().catch(() => ({} as any));
    if (r.ok && data?.inspectionId) {
      router.replace(`/inspection/${data.inspectionId}`);
      return;
    }
    // A genuine 4xx is a real server DECISION (permission/validation) the
    // inspector must see — surface it; a local copy would only fail the same way.
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      setErrorMsg(data?.error || `HTTP ${r.status}`);
      setStage('error');
      // Report the surfaced start failure with the property/template context.
      // (Server also logs it; this adds the client's-eye view + property id.)
      reportError(data?.error || `HTTP ${r.status}`, {
        kind: 'inspection_start', template: String(selectedTemplate || ''),
        propertyId: String(selectedPropertyId || ''), httpStatus: r.status,
      });
      return;
    }
    // 5xx / 429 / malformed-success → the SERVER is the problem, not the request.
    // Don't strand the inspector on an error: start LOCALLY and let the deferred
    // create land the record + re-key when the server recovers.
    if (startLocalInspection()) return;
    setErrorMsg(data?.error || `HTTP ${r.status}`);
    setStage('error');
  }

  // Title-case a template id for the offline display name (the server rewrites
  // inspection_name authoritatively on sync; this is just what shows meanwhile).
  function prettyTemplate(t: string): string {
    return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Create the inspection LOCALLY (no network): generate ids, seed the offline
  // cache so the detail page renders, queue the deferred create, and navigate.
  // Returns false (caller surfaces the original error) if the template's content
  // isn't cached for offline use yet — without it the form can't render offline.
  function startLocalInspection(): boolean {
    const tmpl = selectedTemplate;
    // Community / Visit creation resolves the community server-side, so it needs
    // a connection — don't start it locally/offline.
    if (isCommunityTemplate) return false;
    const contentCached = tmpl === 'pm_scope_rate_card'
      ? !!loadCachedRateCard()
      : tmpl === 'pm_turn_reinspect_qc'
        ? true // QC starts standalone offline (empty rooms); source lines copy on sync
        : !!loadCachedQuestions(tmpl);
    if (!contentCached) {
      setErrorMsg('You appear to be offline and this inspection type hasn’t been downloaded for offline use yet. Open one of this type once on a connection, then you can start it offline.');
      setStage('error');
      return true; // handled (we showed a clear reason) — don't surface the raw error
    }
    const now = Date.now();
    const { tempId, externalId } = newLocalIds(now);
    const today = new Date(now).toISOString().slice(0, 10);
    const inspectionName = `${prettyTemplate(tmpl)} – ${addressSnapshot} – ${today}`;
    const inspectorName = sessionUser?.name || '';
    const inspectorEmail = sessionUser?.email || '';

    const pending = {
      tempId,
      externalId,
      body: {
        templateType: tmpl,
        propertyRecordId: selectedPropertyId,
        propertyAddressSnapshot: addressSnapshot,
        inspectorName,
        inspectorEmail,
        bedrooms,
        bathrooms,
        ...(isQcTemplate ? { sourceRateCardId: selectedSourceId } : {}),
        externalId,
      },
      display: { inspectionName, templateType: tmpl, propertyAddress: addressSnapshot, inspectorName },
      status: 'pending' as const,
      createdAt: now,
    };
    addPendingInspection(pending);

    // Warm the offline cache too (fast path), but the DURABLE pending record above
    // is the real source of truth — the detail page rebuilds from it via
    // buildSeedPayload if this LRU-capped cache entry is ever evicted.
    saveCachedInspection(tempId, buildSeedPayload(pending));

    // Navigate into the (now durably-saved) inspection. If the client navigation
    // FAILS — which happens offline on a build whose inspection-page chunk wasn't
    // precached (a ChunkLoadError) — DON'T leave the inspector on a dead spinner.
    // The inspection is already saved; tell them how to make offline fully work.
    router.replace(`/inspection/${tempId}`).catch(() => {
      setErrorMsg('Your inspection was saved on this device. To open and edit it offline, reconnect to the internet briefly and reopen the app ONCE — that downloads the offline screens. After that it (and starting inspections offline) works with no signal.');
      setStage('error');
    });
    return true;
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
        ...subjectBody(),
        inspectorName,
        inspectorEmail,
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
      {/* Fill the screen and don't rubber-band. position:fixed makes this the
          ONLY scroller (the document/body has nothing to scroll, so iOS can't
          bounce it); overscroll-none kills this element's own end-bounce. The
          form fits on one screen; on a short device it scrolls internally.
          env(safe-area-inset-*) clears the notch and home indicator (0 in a
          normal browser, so web/PWA is unchanged). */}
      <main
        className="fixed inset-0 overflow-y-auto overscroll-none p-4 sm:p-6 bg-white"
        style={{
          paddingTop: 'calc(0.35rem + env(safe-area-inset-top))',
          paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))',
        }}
      >
        <div className="max-w-xl mx-auto">
          <div className="flex items-center justify-between mb-2">
            <Link href="/" className="text-sm text-gray-500 hover:text-ink font-heading">&larr; Home</Link>
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 pt-4 pb-6">
            <h1 className="text-2xl font-heading font-bold mb-1">New Inspection</h1>
            <p className="text-sm text-gray-500 mb-5 font-heading uppercase tracking-wider">
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
                  onChange={(v) => setSelectedTemplate(v)}
                  placeholder="Select template"
                  emptyLabel="No template matches"
                  filled
                  deferKeyboard
                />
              </div>

              {/* Community / Visit: pick a Community (no property, no bed/bath). */}
              {isCommunityTemplate ? (
                <div>
                  <label htmlFor="community-cb" className="block text-sm font-heading font-semibold text-ink mb-1.5">
                    Community
                  </label>
                  <Combobox
                    id="community-cb"
                    options={communities.map((c) => ({
                      value: c.id,
                      label: c.name,
                      sublabel: [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || undefined,
                    }))}
                    value={selectedCommunityId}
                    onChange={setSelectedCommunityId}
                    placeholder={communitiesLoading ? 'Loading communities…' : 'Select a community'}
                    loading={communitiesLoading}
                    emptyLabel={communitiesLoading ? 'Loading…' : 'No communities found'}
                    filled
                    deferKeyboard
                  />
                  {!!communityLocationLine && (
                    <p className="text-xs text-gray-500 mt-1">{communityLocationLine}</p>
                  )}
                </div>
              ) : (
                /* Property */
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
                    filled
                    deferKeyboard
                  />
                </div>
              )}

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
                    <div className="text-sm text-gray-600 border border-gray-200 bg-gray-50 rounded-lg px-3 py-2.5">
                      No recent Scope Rate Card for this property — you can still
                      <span className="font-semibold"> begin a standalone QC</span>:
                      it opens with empty rooms so you can add after-photos and set a
                      final Pass/Fail.
                    </div>
                  ) : (
                    <>
                      <Combobox
                        id="source-rc-cb"
                        options={[
                          { value: '', label: 'None — start a standalone QC', sublabel: 'No source scope; empty rooms + after-photos' },
                          ...sourceOptions.map((o) => ({
                            value: o.recordId,
                            label: o.inspectionName,
                            sublabel: [
                              o.status,
                              o.submittedAt ? new Date(/^\d+$/.test(o.submittedAt) ? Number(o.submittedAt) : o.submittedAt).toLocaleDateString() : null,
                            ].filter(Boolean).join(' · ') || undefined,
                          })),
                        ]}
                        value={selectedSourceId}
                        onChange={setSelectedSourceId}
                        placeholder="Select the inspection to validate (optional)"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Optional. Pick a Scope to validate against (copies its line items
                        for pass/fail), or choose <span className="font-semibold">None</span> to
                        run a standalone QC.
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* Dependent bed/bath — populated from the property record and
                  read-only (greyed) for everyone; bed/bath is no longer an
                  inspector-entered field. Stays editable only as a fallback when
                  the property record has no count, so a missing value can't block
                  starting the inspection. Hidden for Community / Visit (no unit). */}
              {!isCommunityTemplate && (<>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1.5">Bedrooms</label>
                  <NumberField
                    allowDecimal={false}
                    value={bedrooms != null ? String(bedrooms) : ''}
                    onChange={(v) => setBedrooms(v === '' ? null : Number(v))}
                    placeholder={selectedPropertyId ? '0' : 'Select property first'}
                    disabled={!selectedPropertyId || bedrooms != null}
                    ariaLabel="Bedrooms"
                    className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-sm font-heading font-semibold text-ink mb-1.5">Bathrooms</label>
                  <NumberField
                    value={bathrooms != null ? String(bathrooms) : ''}
                    onChange={(v) => setBathrooms(v === '' ? null : Number(v))}
                    placeholder={selectedPropertyId ? '0' : 'Select property first'}
                    disabled={!selectedPropertyId || bathrooms != null}
                    ariaLabel="Bathrooms"
                    className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </div>
              </div>
              {selectedPropertyId && (bedrooms == null || bathrooms == null) && (
                <p className="text-xs text-gray-500 -mt-2">
                  Bedroom/bathroom counts weren&apos;t found on the property record. Please enter them manually.
                </p>
              )}
              </>)}

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
                        clearCachedMe(); // don't keep the signed-out user cached for offline reloads
                        router.replace('/login');
                      }} className="text-brand underline">Sign out</button> to change.
                    </p>
                  </>
                )}
              </div>

              {/* External-user property-status gate: explain why Begin is locked. */}
              {blockedByPropertyStatus && (
                <div className="mt-2 p-3 rounded-lg bg-pink-50 border border-pink-200 text-sm text-pink-900">
                  <div className="font-heading font-bold text-brand mb-0.5">Not Ready to Walk</div>
                  {EXTERNAL_1099_STATUS_BLOCK_MSG}
                </div>
              )}
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
