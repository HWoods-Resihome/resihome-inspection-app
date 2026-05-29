import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type {
  Question, Property, AnswerInput, SubmitPayload, SubmitResult, TemplateType, HubSpotUser,
} from '@/lib/types';
import { QuestionForm } from '@/components/QuestionForm';
import { Combobox } from '@/components/Combobox';

type Stage = 'setup' | 'loading_questions' | 'form' | 'submitting' | 'generating_pdf' | 'done' | 'error';

// Default scheduled date: tomorrow at 9am local time, formatted YYYY-MM-DD
// (input[type=date] only accepts date-only format).
function defaultScheduledDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const TEMPLATE_OPTIONS: { value: TemplateType; label: string; sublabel: string }[] = [
  { value: 'pm_scope_rate_card',                        label: '(PM) Scope Rate Card',                 sublabel: 'Priced line items; tenant chargebacks + vendor bids' },
  { value: 'pm_community_inspection',                   label: '(PM) Community / Visit Inspection',    sublabel: 'Community grounds, amenities, signage' },
  { value: 'pm_vacancy_occupancy_check',                label: '(PM) Vacancy / Occupancy Check',       sublabel: 'Quick visit to confirm vacancy/security' },
  { value: 'qc_new_construction_rrqc',                  label: '(QC) New Construction RRQC',           sublabel: 'Rent-ready QC for new construction' },
  { value: 'leasing_agent_1099_property_inspection',    label: '1099 Leasing Agent Property Inspection', sublabel: 'Pre-tour assessment by leasing agent' },
];

function templateLabel(v: TemplateType): string {
  return TEMPLATE_OPTIONS.find((t) => t.value === v)?.label || v;
}

export default function NewInspection() {
  const router = useRouter();

  // Setup stage state
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertiesLoading, setPropertiesLoading] = useState(true);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);

  // Logged-in user is the inspector. Fetched once from /api/auth/me.
  const [sessionUser, setSessionUser] = useState<{ userId: string; email: string; name: string } | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const [selectedTemplate, setSelectedTemplate] = useState<TemplateType | ''>('');
  const [selectedPropertyId, setSelectedPropertyId] = useState('');
  const [bedrooms, setBedrooms] = useState<number | null>(null);
  const [bathrooms, setBathrooms] = useState<number | null>(null);

  // Schedule-mode state. When `scheduling` is true, the schedule panel is shown
  // below the buttons. The user picks a date + inspector, then confirms.
  const [scheduling, setScheduling] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<string>(defaultScheduledDate());
  const [scheduledInspectorEmail, setScheduledInspectorEmail] = useState<string>('');
  const [users, setUsers] = useState<HubSpotUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [schedulingBusy, setSchedulingBusy] = useState(false);

  // Form stage state
  const [questions, setQuestions] = useState<Question[]>([]);
  const [stage, setStage] = useState<Stage>('setup');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [startedAt] = useState<string>(new Date().toISOString());

  // Load properties + session in parallel
  useEffect(() => {
    fetch('/api/properties')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setPropertiesError(data.error);
        else setProperties(data.properties || []);
      })
      .catch((e) => setPropertiesError(String(e.message || e)))
      .finally(() => setPropertiesLoading(false));

    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) setSessionUser(data.user);
      })
      .catch(() => {})
      .finally(() => setSessionLoading(false));
  }, []);

  // Dependent bed/bath: when property changes, reset/populate from property data
  useEffect(() => {
    if (!selectedPropertyId) {
      setBedrooms(null);
      setBathrooms(null);
      return;
    }
    const p = properties.find((x) => x.recordId === selectedPropertyId);
    if (p) {
      setBedrooms(p.bedrooms ?? null);
      setBathrooms(p.bathrooms ?? null);
    }
  }, [selectedPropertyId, properties]);

  const selectedProperty = useMemo(
    () => properties.find((p) => p.recordId === selectedPropertyId),
    [properties, selectedPropertyId]
  );

  const propertyOptions = useMemo(
    () => properties.map((p) => ({
      value: p.recordId,
      label: p.name,
      sublabel: [p.city, p.state].filter(Boolean).join(', ') || undefined,
    })),
    [properties]
  );
  const templateOptions = useMemo(
    () => TEMPLATE_OPTIONS.map((t) => ({ value: t.value, label: t.label, sublabel: t.sublabel })),
    []
  );

  const setupReady = !!selectedTemplate
    && !!selectedPropertyId
    && !!sessionUser
    && bedrooms != null
    && bathrooms != null;

  async function handleBegin() {
    if (!setupReady) {
      alert('Please complete every field before beginning.');
      return;
    }
    setStage('loading_questions'); // shows a loading state while we create+navigate
    try {
      const body = {
        templateType: selectedTemplate,
        propertyRecordId: selectedPropertyId,
        propertyAddressSnapshot: selectedProperty?.name || `(Property ${selectedPropertyId})`,
        inspectorName: sessionUser?.name || '',
        inspectorEmail: sessionUser?.email,
        bedrooms,
        bathrooms,
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

  // Open the schedule panel. Lazy-load users on first open.
  async function handleOpenSchedule() {
    if (!setupReady) {
      alert('Please complete the template, property, and bed/bath counts first.');
      return;
    }
    setScheduling(true);
    // Default assignee = the current user
    if (!scheduledInspectorEmail && sessionUser?.email) {
      setScheduledInspectorEmail(sessionUser.email);
    }
    // Load users if we haven't already
    if (users.length === 0 && !usersLoading) {
      setUsersLoading(true);
      try {
        const r = await fetch('/api/users');
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
        setUsers(data.users || []);
      } catch (e) {
        console.error('Failed to load users for scheduling:', e);
        // Non-fatal: user can still schedule for themselves
      } finally {
        setUsersLoading(false);
      }
    }
  }

  // Confirm the scheduled inspection: create the record, then go back home.
  async function handleConfirmSchedule() {
    if (!setupReady) return;
    if (!scheduledDate) {
      alert('Please pick a scheduled date.');
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
        propertyAddressSnapshot: selectedProperty?.name || `(Property ${selectedPropertyId})`,
        inspectorName,
        inspectorEmail,
        bedrooms,
        bathrooms,
        scheduledDate,
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
      alert(`Could not schedule inspection: ${e.message || e}`);
      setSchedulingBusy(false);
    }
  }

  async function handleSubmit(answers: AnswerInput[], sectionPhotoUrls: Record<string, string[]>) {
    setStage('submitting');

    const payload: SubmitPayload = {
      templateType: selectedTemplate as TemplateType,
      propertyRecordId: selectedPropertyId,
      propertyAddressSnapshot: selectedProperty?.name || `(Property ${selectedPropertyId})`,
      inspectorName: sessionUser?.name || '',
      inspectorEmail: sessionUser?.email || undefined,
      bedrooms: bedrooms || 0,
      bathrooms: bathrooms || 0,
      startedAt,
      completedAt: new Date().toISOString(),
      answers,
      sectionPhotoUrls,
    };

    let submitData: SubmitResult;
    try {
      const r = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      submitData = await r.json();
      if (!submitData.success) {
        throw new Error(submitData.error || 'Submission failed');
      }
    } catch (e: any) {
      setErrorMsg(String(e.message || e));
      setStage('error');
      return;
    }

    setStage('generating_pdf');
    try {
      const pdfReq = {
        inspectionRecordId: submitData.inspectionRecordId,
        externalId: submitData.inspectionExternalId,
        templateLabel: templateLabel(selectedTemplate as TemplateType),
        inspectionName: submitData.inspectionName || `Inspection ${submitData.inspectionExternalId}`,
        propertyAddress: payload.propertyAddressSnapshot,
        inspectorName: payload.inspectorName,
        bedrooms: payload.bedrooms,
        bathrooms: payload.bathrooms,
        completedAt: payload.completedAt,
        answers: payload.answers,
        sectionPhotoUrls: payload.sectionPhotoUrls,
      };
      const r = await fetch('/api/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pdfReq),
      });
      const pdfData = await r.json();
      if (pdfData.success) {
        submitData.pdfUrl = pdfData.pdfUrl;
      } else {
        console.error('PDF generation failed:', pdfData.error);
      }
    } catch (e: any) {
      console.error('PDF generation error:', e);
    }

    setSubmitResult(submitData);
    setStage('done');
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

  if (stage === 'done' && submitResult) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-white">
        <div className="max-w-md w-full bg-white p-8 rounded-2xl border border-gray-200 shadow text-center">
          <div className="w-20 h-20 mx-auto bg-accent rounded-full flex items-center justify-center mb-4">
            <svg className="w-10 h-10 text-ink" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-heading font-bold mb-2">Inspection submitted</h2>
          <p className="text-gray-600 mb-6 text-sm">
            Created in HubSpot.<br />
            <span className="text-xs text-gray-400">{submitResult.inspectionExternalId}</span>
          </p>
          <div className="space-y-3">
            {submitResult.pdfUrl && (
              <a
                href={submitResult.pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="block w-full bg-brand hover:bg-brand-dark text-white font-heading font-semibold py-3 px-4 rounded-lg"
              >
                Download PDF
              </a>
            )}
            <a
              href={submitResult.hubspotUrl}
              target="_blank"
              rel="noreferrer"
              className="block w-full bg-ink hover:bg-gray-800 text-white font-heading font-semibold py-3 px-4 rounded-lg"
            >
              Open in HubSpot
            </a>
            <Link href="/" className="block text-brand hover:underline font-heading">
              Back to home
            </Link>
          </div>
          {!submitResult.pdfUrl && (
            <p className="text-xs text-gray-400 mt-4">
              PDF generation didn&apos;t complete, but your data is saved.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (stage === 'submitting' || stage === 'generating_pdf') {
    const label = stage === 'submitting'
      ? 'Submitting inspection to HubSpot...'
      : 'Generating PDF...';
    const sublabel = stage === 'submitting'
      ? 'Creating Inspection, Answer records, and associations'
      : 'Composing PDF and uploading to HubSpot Files';
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-white">
        <div className="text-center">
          <div className="inline-block w-14 h-14 border-4 border-brand border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-gray-700 font-heading font-semibold">{label}</p>
          <p className="text-xs text-gray-400 mt-2">{sublabel}</p>
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
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
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
                  placeholder={propertiesLoading ? 'Loading properties...' : 'Search and select a property'}
                  loading={propertiesLoading}
                  error={propertiesError}
                  emptyLabel="No properties match your search"
                />
              </div>

              {/* Inspector - locked to logged-in user */}
              <div>
                <label className="block text-sm font-heading font-semibold text-ink mb-1.5">
                  Inspector
                </label>
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
              </div>

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

              {/* Two-button row: Begin (primary) | Schedule (secondary) */}
              {!scheduling && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button
                    onClick={handleBegin}
                    disabled={!setupReady}
                    className="bg-brand hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-heading font-semibold py-3.5 px-3 rounded-lg transition active:scale-[0.98]"
                  >
                    Begin Inspection
                  </button>
                  <button
                    onClick={handleOpenSchedule}
                    disabled={!setupReady}
                    className="border-2 border-brand text-brand hover:bg-pink-100 disabled:border-gray-300 disabled:text-gray-400 disabled:cursor-not-allowed font-heading font-semibold py-3.5 px-3 rounded-lg transition active:scale-[0.98]"
                    title="Create a Scheduled Inspection for someone (or yourself) to start later"
                  >
                    Schedule Inspection
                  </button>
                </div>
              )}

              {/* Schedule panel: shown when "Schedule Inspection" was clicked. */}
              {scheduling && (
                <div className="mt-2 bg-pink-100 border border-pink-200 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-heading font-bold text-brand text-sm">Schedule this Inspection</h3>
                    <button
                      type="button"
                      onClick={() => setScheduling(false)}
                      className="text-xs text-gray-600 hover:text-ink underline"
                    >
                      Cancel
                    </button>
                  </div>

                  <div>
                    <label className="block text-xs font-heading font-bold text-ink uppercase tracking-wider mb-1">
                      Scheduled Date
                    </label>
                    <input
                      type="date"
                      value={scheduledDate}
                      onChange={(e) => setScheduledDate(e.target.value)}
                      onClick={(e) => {
                        // Open the native date picker when the user taps anywhere
                        // in the input, not just the tiny calendar icon.
                        // showPicker() requires a user gesture (which onClick provides)
                        // and is supported in Chrome 99+, Safari 16+, Firefox 101+.
                        const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
                        try { el.showPicker?.(); } catch { /* fallback: native behavior */ }
                      }}
                      className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white cursor-pointer"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-heading font-bold text-ink uppercase tracking-wider mb-1">
                      Assign to Inspector
                    </label>
                    {usersLoading ? (
                      <div className="text-sm text-gray-500 py-2">Loading inspectors&hellip;</div>
                    ) : users.length === 0 ? (
                      <div className="text-sm text-gray-600 py-2">
                        Couldn&apos;t load the inspector list. The Inspection will be assigned to you ({sessionUser?.name}).
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
                    )}
                  </div>

                  <button
                    onClick={handleConfirmSchedule}
                    disabled={schedulingBusy || !scheduledDate}
                    className="w-full bg-brand hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-heading font-semibold py-3 px-4 rounded-lg transition active:scale-[0.98]"
                  >
                    {schedulingBusy ? 'Scheduling\u2026' : 'Confirm Schedule'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
