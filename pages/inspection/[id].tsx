import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useAppDialog } from '@/components/AppDialog';
import { useFlash } from '@/components/Flash';
import type {
  Question, AnswerInput, TemplateType, InspectionSummary,
} from '@/lib/types';
import type { SavedAnswer } from '@/lib/hubspot';
import { templateLabel as templateLabelFor } from '@/lib/templateLabels';
import {
  saveCachedInspection, loadCachedInspection,
  saveCachedQuestions, loadCachedQuestions,
} from '@/lib/offlineCache';
import { getGeoFix } from '@/lib/evidenceStamp';
import { openPdf } from '@/lib/pdfViewerBus';
import type { QuestionFormSubmitMeta } from '@/components/QuestionForm';


// The three inspection forms are heavy and MUTUALLY EXCLUSIVE — exactly one
// renders per inspection (by template type). Load each on demand so a Scope
// inspection doesn't also ship the QC + Question form bundles (and vice-versa),
// cutting first-load JS on the field phones inspectors actually use. ssr:false
// because the page shell is static and these are interactive client-only forms.
const FormLoading = () => <div className="p-6 text-sm text-gray-500">Loading…</div>;
const QuestionForm = dynamic(() => import('@/components/QuestionForm').then((m) => m.QuestionForm), { loading: FormLoading, ssr: false });
const RateCardForm = dynamic(() => import('@/components/RateCardForm').then((m) => m.RateCardForm), { loading: FormLoading, ssr: false });
const QcReinspectForm = dynamic(() => import('@/components/QcReinspectForm').then((m) => m.QcReinspectForm), { loading: FormLoading, ssr: false });

type Stage = 'loading' | 'loading_questions' | 'form' | 'submitting' | 'generating_pdf' | 'creating_ticket' | 'done' | 'error';

interface ShareLinks {
  master: string | null;
  chargeback: string | null;
  xlsx: string | null;
  report: string | null;
  vendors: Record<string, string>;
}

export default function ExistingInspection() {
  const dialog = useAppDialog();
  const { runTicketUpload } = useFlash();
  const router = useRouter();
  const idParam = router.query.id;
  const inspectionId = typeof idParam === 'string' ? idParam : '';

  const [stage, setStage] = useState<Stage>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Logged-in user's email + admin flag — used to mirror the server's
  // dual-approval lockout in the UI (the submitter can never finalize their own
  // submission; a second reviewer must — unless this user is a finalize admin).
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [isFinalizeAdmin, setIsFinalizeAdmin] = useState(false);
  const [isExternal, setIsExternal] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        if (d.user?.email) setCurrentUserEmail(String(d.user.email));
        setIsFinalizeAdmin(!!d.isFinalizeAdmin);
        setIsExternal(!!d.isExternal);
      })
      .catch(() => { /* non-fatal: lockout still enforced server-side */ });
    return () => { cancelled = true; };
  }, []);

  // Prime the browser's Location permission as soon as an inspection opens, so
  // the OS/Safari prompt resolves BEFORE the first photo is taken and GPS is
  // ready to stamp evidence. The native shell already primes at app launch
  // (primeLocationPermissionNative), but on web/PWA — where there's no launch
  // hook — the only place location was requested was on camera-open, which is
  // late and easy to miss. getCurrentPosition is idempotent: the browser shows
  // its prompt once, then silently grants/denies on later calls. Best-effort
  // and silent; a denial/timeout just no-ops and the stamp falls back to no GPS.
  useEffect(() => {
    void getGeoFix().catch(() => { /* denied/unavailable — silent */ });
  }, []);

  const [inspection, setInspection] = useState<InspectionSummary | null>(null);
  const [propertyRecordId, setPropertyRecordId] = useState<string>('');
  const [propertySquareFootage, setPropertySquareFootage] = useState<number | null>(null);
  const [propertyZip, setPropertyZip] = useState<string | null>(null);
  const [propertyLastTenantMonths, setPropertyLastTenantMonths] = useState<number | null>(null);
  const [propertyAirFiltersTotal, setPropertyAirFiltersTotal] = useState<number | null>(null);
  const [propertyAirFiltersType1, setPropertyAirFiltersType1] = useState<string | null>(null);
  const [propertyAirFiltersType2, setPropertyAirFiltersType2] = useState<string | null>(null);
  const [propertyAirFiltersType3, setPropertyAirFiltersType3] = useState<string | null>(null);
  const [propertySepticFee, setPropertySepticFee] = useState<number | null>(null);
  const [listingPrice, setListingPrice] = useState<number | null>(null);
  const [listingDate, setListingDate] = useState<string | null>(null);
  const [listingStatus, setListingStatus] = useState<string | null>(null);
  const [communityName, setCommunityName] = useState<string | null>(null);
  const [filterSizeOptions, setFilterSizeOptions] = useState<string[]>([]);
  const [existingAnswers, setExistingAnswers] = useState<SavedAnswer[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [submitResultUrl, setSubmitResultUrl] = useState<string>('');
  const [pdfUrl, setPdfUrl] = useState<string>('');
  // Maintenance ticket raised from a failed 1099/vacancy sign-off (null = none
  // attempted). Shown on the completed screen with a link into the MM system.
  const [ticketResult, setTicketResult] = useState<{ ok: boolean; url?: string | null; error?: string } | null>(null);
  // Clean short links (resolve to the real files) for downloads — covers all
  // templates. Computed server-side; null until loaded.
  const [shareLinks, setShareLinks] = useState<ShareLinks | null>(null);

  // Load inspection + answers
  useEffect(() => {
    if (!inspectionId) return;
    let cancelled = false;
    (async () => {
      // Apply a GET /api/inspections/[id] payload to state. Shared by the live
      // fetch and the offline-cache fallback so both paths render identically.
      const applyInspectionData = (data: any) => {
        setInspection(data.inspection);
        setShareLinks(data.shareLinks || null);
        setPropertyRecordId(data.propertyRecordId || '');
        setPropertySquareFootage(
          typeof data.propertySquareFootage === 'number' ? data.propertySquareFootage : null
        );
        setPropertyZip(typeof data.propertyZip === 'string' ? data.propertyZip : null);
        setPropertyLastTenantMonths(
          typeof data.propertyLastTenantMonths === 'number' ? data.propertyLastTenantMonths : null
        );
        setPropertyAirFiltersTotal(
          typeof data.propertyAirFiltersTotal === 'number' ? data.propertyAirFiltersTotal : null
        );
        setPropertyAirFiltersType1(typeof data.propertyAirFiltersType1 === 'string' ? data.propertyAirFiltersType1 : null);
        setPropertyAirFiltersType2(typeof data.propertyAirFiltersType2 === 'string' ? data.propertyAirFiltersType2 : null);
        setPropertyAirFiltersType3(typeof data.propertyAirFiltersType3 === 'string' ? data.propertyAirFiltersType3 : null);
        setPropertySepticFee(
          typeof data.propertySepticFee === 'number' ? data.propertySepticFee : null
        );
        setListingPrice(typeof data.listingPrice === 'number' ? data.listingPrice : null);
        setListingDate(typeof data.listingDate === 'string' ? data.listingDate : null);
        setListingStatus(typeof data.listingStatus === 'string' ? data.listingStatus : null);
        setCommunityName(typeof data.communityName === 'string' ? data.communityName : null);
        setFilterSizeOptions(Array.isArray(data.filterSizeOptions) ? data.filterSizeOptions : []);
        setExistingAnswers(data.answers || []);
      };

      // Load a questionnaire template's questions, caching for offline reuse and
      // falling back to the cached copy when the network is unavailable.
      const loadQuestionsFor = async (tmpl: string): Promise<Question[] | null> => {
        try {
          const qr = await fetch(`/api/questions?template=${encodeURIComponent(tmpl)}`);
          const qData = await qr.json();
          if (!qr.ok || qData.error) throw new Error(qData.error || `Questions HTTP ${qr.status}`);
          const qs: Question[] = qData.questions || [];
          saveCachedQuestions(tmpl, qs);
          return qs;
        } catch {
          return loadCachedQuestions<Question>(tmpl);
        }
      };

      // Render once we have an inspection payload (live OR cached): apply it,
      // then load questions for questionnaire templates.
      const finish = async (data: any, fromCache: boolean) => {
        if (cancelled) return;
        applyInspectionData(data);
        const tmpl = data.inspection?.templateType;
        if (!tmpl) { setErrorMsg('Inspection has no template type set'); setStage('error'); return; }
        // Rate Card + QC supply their own content (catalog / qc-data) — no questions.
        if (tmpl === 'pm_scope_rate_card' || tmpl === 'pm_turn_reinspect_qc') {
          setQuestions([]); setStage('form'); return;
        }
        setStage('loading_questions');
        const qs = await loadQuestionsFor(tmpl);
        if (cancelled) return;
        if (qs) { setQuestions(qs); setStage('form'); return; }
        setErrorMsg(fromCache
          ? 'This inspection isn’t cached for offline use yet — open it once with a connection to enable it offline.'
          : 'Could not load questions.');
        setStage('error');
      };

      try {
        const r = await fetch(`/api/inspections/${inspectionId}`);
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
        if (cancelled) return;
        saveCachedInspection(inspectionId, data); // warm the offline cache for dead-zone re-opens
        await finish(data, false);
      } catch (e: any) {
        // Offline / fetch failed → use the cached payload so the inspection still
        // opens and is fully editable; saves queue and sync when service returns.
        const cached = loadCachedInspection(inspectionId);
        if (cached && !cancelled) {
          await finish(cached, true);
        } else if (!cancelled) {
          setErrorMsg(String(e?.message || e));
          setStage('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [inspectionId]);

  async function handleSubmit(answers: AnswerInput[], sectionPhotoUrls: Record<string, string[]>, meta?: QuestionFormSubmitMeta) {
    if (!inspection) return;
    setStage('submitting');
    try {
      // Finalize inspection: status -> Completed
      const totalQuestionsAnswered = answers.filter((a) => a.answerValue).length;
      const totalPhotos = answers.reduce((acc, a) => acc + a.photoUrls.length, 0)
        + Object.values(sectionPhotoUrls).reduce((acc, urls) => acc + urls.length, 0);

      const r = await fetch(`/api/inspections/${inspectionId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalQuestionsAnswered, totalPhotos, inspectionResult: meta?.inspectionResult ?? null }),
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
      setSubmitResultUrl(data.hubspotUrl || '');

      setStage('generating_pdf');
      let generatedPdfUrl = '';
      try {
        const pdfReq = {
          inspectionRecordId: inspectionId,
          externalId: inspection.inspectionIdExternal,
          templateLabel: templateLabelFor(inspection.templateType) || inspection.templateType,
          inspectionName: inspection.inspectionName,
          propertyAddress: inspection.propertyAddressSnapshot,
          inspectorName: inspection.inspectorName,
          bedrooms: inspection.bedroomsAtInspection || 0,
          bathrooms: inspection.bathroomsAtInspection || 0,
          squareFootage: propertySquareFootage,
          region: inspection.regionSnapshot || null,
          listingStatus,
          listingPrice,
          listingDate,
          completedAt: new Date().toISOString(),
          answers,
          sectionPhotoUrls,
          finalChecklist: meta?.finalChecklist,
          finalChecklistPhotos: meta?.finalChecklistPhotos,
          communityName,
        };
        const pdfResp = await fetch('/api/pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pdfReq),
        });
        if (pdfResp.ok) {
          const pdfData = await pdfResp.json();
          if (pdfData.pdfUrl) { generatedPdfUrl = pdfData.pdfUrl; setPdfUrl(pdfData.pdfUrl); }
        }
      } catch (e) {
        console.warn('PDF generation failed (non-fatal):', e);
      }

      // Failed 1099 / vacancy sign-off where the inspector asked for a ticket:
      // CREATE the ticket (fast — single API call) so we have the link, then
      // attach the completed PDF in the BACKGROUND (the HoneyBadger browser
      // automation is slow; it must never block the completion screen). Best-
      // effort: the inspection is already completed regardless of the outcome.
      if (meta?.maintenanceTicket?.wanted && meta.maintenanceTicket.description) {
        setStage('creating_ticket');
        try {
          const tr = await fetch(`/api/inspections/${inspectionId}/create-inspection-ticket`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: meta.maintenanceTicket.description }),
          });
          const td = await tr.json().catch(() => ({}));
          if (td?.ok) {
            setTicketResult({ ok: true, url: td.url });
            // Fire-and-forget the PDF attach via the app-root Flash runner, which
            // toasts the result and survives navigation away from this page.
            runTicketUpload(inspectionId, td.ticketId, generatedPdfUrl);
          } else {
            setTicketResult({ ok: false, error: td?.error || 'Ticket could not be created.' });
          }
        } catch (e: any) {
          setTicketResult({ ok: false, error: String(e?.message || e) });
        }
      }

      setStage('done');
    } catch (e: any) {
      setErrorMsg(String(e.message || e));
      setStage('error');
    }
  }

  async function handleCancelInspection() {
    if (!(await dialog.confirm('Mark this Inspection as Cancelled? This will preserve all current answers but flag the Inspection as cancelled in HubSpot.', { confirmLabel: 'Mark Cancelled', cancelLabel: 'Keep' }))) return;
    try {
      const r = await fetch(`/api/inspections/${inspectionId}/cancel`, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      router.push('/?just_cancelled=1');
    } catch (e: any) {
      void dialog.alert(`Cancel failed: ${e.message || e}`);
    }
  }

  async function handleReopen() {
    if (!(await dialog.confirm('Reopen this completed inspection for editing? Status will change back to In Progress.', { confirmLabel: 'Reopen' }))) return;
    try {
      const r = await fetch(`/api/inspections/${inspectionId}/reopen`, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      // Refresh
      window.location.reload();
    } catch (e: any) {
      void dialog.alert(`Reopen failed: ${e.message || e}`);
    }
  }

  // ----- Render -----

  if (stage === 'loading' || stage === 'loading_questions') {
    return (
      <Layout>
        <div className="text-center py-12">
          <div className="text-sm text-gray-500 font-heading">
            {stage === 'loading' ? 'Loading inspection...' : 'Loading template...'}
          </div>
        </div>
      </Layout>
    );
  }

  if (stage === 'error') {
    return (
      <Layout>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-3">
          <div className="font-heading font-bold mb-1">Could not load inspection</div>
          <div>{errorMsg}</div>
          <button onClick={() => router.push('/')} className="mt-3 text-brand underline text-xs">
            Back to Inspections List
          </button>
        </div>
      </Layout>
    );
  }

  if (stage === 'submitting') {
    return (
      <Layout>
        <div className="text-center py-12">
          <div className="text-sm text-brand font-heading font-semibold">Submitting inspection...</div>
        </div>
      </Layout>
    );
  }

  if (stage === 'generating_pdf') {
    return (
      <Layout>
        <div className="text-center py-12">
          <div className="text-sm text-brand font-heading font-semibold">Generating PDF report...</div>
        </div>
      </Layout>
    );
  }

  if (stage === 'creating_ticket') {
    return (
      <Layout>
        <div className="text-center py-12">
          <div className="text-sm text-brand font-heading font-semibold">Creating maintenance ticket...</div>
        </div>
      </Layout>
    );
  }

  if (stage === 'done') {
    return (
      <Layout>
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-sm text-green-800 mb-3">
          <div className="font-heading font-bold text-lg mb-2">Inspection Submitted</div>
          <div className="mb-3">This Inspection is now marked Completed in HubSpot.</div>
          {submitResultUrl && (
            <a href={submitResultUrl} target="_blank" rel="noreferrer" className="text-brand underline block mb-2">
              View in HubSpot
            </a>
          )}
          {pdfUrl && (
            <a
              href={pdfUrl}
              onClick={(e) => { e.preventDefault(); openPdf(pdfUrl, `${templateLabel} Report`); }}
              className="text-brand underline block cursor-pointer"
            >
              View PDF Report
            </a>
          )}
          {ticketResult && (
            <div className={`mt-3 rounded-lg border p-3 ${ticketResult.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
              {ticketResult.ok ? (
                <>
                  <div className="font-heading font-bold text-emerald-800">Maintenance ticket created</div>
                  {ticketResult.url && (
                    <a href={ticketResult.url} target="_blank" rel="noreferrer" className="text-brand underline block mt-1">
                      View ticket in Maintenance system
                    </a>
                  )}
                </>
              ) : (
                <>
                  <div className="font-heading font-bold text-red-800">Maintenance ticket not created</div>
                  <div className="text-xs text-red-900 mt-1">{ticketResult.error || 'Reason unknown.'} The inspection is still completed.</div>
                </>
              )}
            </div>
          )}
          <button onClick={() => router.push('/?just_submitted=1')} className="mt-4 bg-brand text-white font-heading font-semibold px-4 py-2 rounded-lg">
            Back to Inspections List
          </button>
        </div>
      </Layout>
    );
  }

  // stage === 'form'
  if (!inspection) return null;
  const isCompleted = (inspection.status || '').toLowerCase() === 'completed';
  const isCancelled = (inspection.status || '').toLowerCase() === 'cancelled';
  const statusReadOnly = isCompleted || isCancelled;
  // External (1099) users may only edit/cancel inspections they own; any other
  // 1099 they can see is view-only. Mirrors the server guard — unknown owner
  // (blank inspector_email) counts as own so legacy records aren't locked out.
  const ownsThis = !inspection.inspectorEmail
    || (!!currentUserEmail && currentUserEmail.trim().toLowerCase() === inspection.inspectorEmail.trim().toLowerCase());
  const externalViewOnly = isExternal && !ownsThis && !statusReadOnly;
  const readOnly = statusReadOnly || externalViewOnly;
  const templateLabel = templateLabelFor(inspection.templateType) || inspection.templateType;

  // Compose the display address: append the property's zip code if we have
  // one and the address doesn't already include it. This handles both cases
  // where the snapshot was built with or without the zip.
  const baseAddress = inspection.propertyAddressSnapshot || `Property ${propertyRecordId}`;
  const propertyName = (() => {
    if (!propertyZip) return baseAddress;
    if (baseAddress.includes(propertyZip)) return baseAddress;
    return `${baseAddress} ${propertyZip}`;
  })();

  return (
    <>
      <Head>
        <title>{inspection.propertyAddressSnapshot || 'Inspection'} - ResiHome</title>
      </Head>
      {/* Single fixed scroll container so the DOCUMENT never scrolls — the only
          way to stop iOS's native WKWebView rubber-band (CSS overscroll-behavior
          doesn't govern it). The pinned top block sticks to the top of THIS
          element; the fixed bottom action bar stays viewport-relative (this
          element has no transform, so it isn't a containing block for
          position:fixed). RateCardForm scrolls this via #page-scroll. */}
      <div id="page-scroll" className="fixed inset-0 overflow-y-auto overscroll-none">
      {externalViewOnly && (
        <div className="bg-sky-50 border-b border-sky-200 py-2">
          <div className="max-w-7xl mx-auto px-3 sm:px-6 text-xs sm:text-sm text-sky-900 font-heading font-semibold">
            View only — this inspection belongs to another agent. You can review it, but can’t make changes.
          </div>
        </div>
      )}
      {statusReadOnly && (
        <div className="bg-amber-50 border-b border-amber-200 py-1.5">
          {/* Banner: status (left, the single source of truth for the read-only
              state — no longer duplicated in the form header) · the Scope
              multi-report menu (center, Scope only — every other template shows
              an in-app "View PDF Report" link in its own header) · Re-Open
              (right). */}
          <div className="max-w-7xl mx-auto px-3 sm:px-6 flex items-center gap-2 flex-nowrap">
            {/* Left zone: read-only status, left-aligned. */}
            <div className="flex-1 min-w-0 flex items-center">
              <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-gray-600 font-heading font-semibold whitespace-nowrap">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                {isCompleted ? 'Completed (read-only)' : 'Cancelled (read-only)'}
              </span>
            </div>

            {/* Center: Scope has multiple reports (master/vendor/chargeback), so
                it keeps its download menu. */}
            <div className="flex items-center justify-center gap-2 shrink-0">
              {isCompleted && inspection.templateType === 'pm_scope_rate_card' && (
                <CompletedPdfMenu inspection={inspection} shareLinks={shareLinks} />
              )}
            </div>

            {/* Right: Re-Open for Edits (secondary, plain text link — underlines
                on hover and while pressed, no box). Hidden for external (1099)
                users — they can't edit completed inspections. */}
            {isCompleted && !isExternal ? (
              <button
                onClick={handleReopen}
                className="flex-1 min-w-0 text-right text-xs sm:text-sm text-brand font-heading font-semibold whitespace-nowrap bg-transparent border-0 p-0 cursor-pointer hover:underline active:underline underline-offset-2"
              >
                <span className="sm:hidden">Re-Open</span>
                <span className="hidden sm:inline">Re-Open for Edits</span>
              </button>
            ) : <span className="flex-1 min-w-0" />}
          </div>
        </div>
      )}
      {inspection.templateType === 'pm_turn_reinspect_qc' ? (
        <QcReinspectForm
          inspectionRecordId={inspectionId}
          propertyRecordId={propertyRecordId}
          templateLabel={templateLabel}
          inspectorName={inspection.inspectorName}
          propertyName={propertyName}
          bedrooms={inspection.bedroomsAtInspection || 0}
          bathrooms={inspection.bathroomsAtInspection || 0}
          squareFootage={propertySquareFootage}
          inspectionStatus={inspection.status}
          pdfUrl={isCompleted ? (shareLinks?.report || inspection.pdfUrl || undefined) : undefined}
          readOnly={readOnly}
          onSubmit={() => router.push('/')}
          onCancel={() => router.push('/')}
          onCancelInspection={readOnly ? undefined : handleCancelInspection}
        />
      ) : inspection.templateType === 'pm_scope_rate_card' ? (
        <RateCardForm
          templateType={inspection.templateType as TemplateType}
          propertyRecordId={propertyRecordId}
          templateLabel={templateLabel}
          inspectorName={inspection.inspectorName}
          submittedAt={inspection.submittedAt}
          submittedByEmail={inspection.submittedByEmail}
          currentUserEmail={currentUserEmail}
          isFinalizeAdmin={isFinalizeAdmin}
          approverName={inspection.approvedByName}
          approvedAt={inspection.approvedAt}
          propertyName={propertyName}
          bedrooms={inspection.bedroomsAtInspection || 0}
          bathrooms={inspection.bathroomsAtInspection || 0}
          squareFootage={propertySquareFootage}
          listingPrice={listingPrice}
          listingDate={listingDate}
          lastTenantMonths={propertyLastTenantMonths}
          propertyAirFiltersTotal={propertyAirFiltersTotal}
          propertyAirFiltersType1={propertyAirFiltersType1}
          propertyAirFiltersType2={propertyAirFiltersType2}
          propertyAirFiltersType3={propertyAirFiltersType3}
          propertySepticFee={propertySepticFee}
          filterSizeOptions={filterSizeOptions}
          inspectionStatus={inspection.status}
          inspectionRegion={inspection.regionSnapshot || ''}
          sectionListJson={inspection.sectionListJson}
          onSubmit={() => router.push('/')}
          onCancel={() => router.push('/')}
          inspectionRecordId={inspectionId}
          inspectionExternalId={inspection.inspectionIdExternal}
          pdfUrl={shareLinks?.report || inspection.pdfUrl || undefined}
          readOnly={readOnly}
          onCancelInspection={readOnly ? undefined : handleCancelInspection}
        />
      ) : (
        <>
        <QuestionForm
          questions={questions}
          propertyRecordId={propertyRecordId}
          templateType={inspection.templateType as TemplateType}
          templateLabel={templateLabel}
          inspectorName={inspection.inspectorName}
          propertyName={propertyName}
          bedrooms={inspection.bedroomsAtInspection || 0}
          bathrooms={inspection.bathroomsAtInspection || 0}
          squareFootage={propertySquareFootage}
          inspectionRegion={inspection.regionSnapshot || ''}
          status={inspection.status}
          submittedAt={inspection.submittedAt}
          listingPrice={listingPrice}
          listingDate={listingDate}
          listingStatus={listingStatus}
          communityName={communityName}
          propertyAirFiltersTotal={propertyAirFiltersTotal}
          propertyAirFiltersType1={propertyAirFiltersType1}
          propertyAirFiltersType2={propertyAirFiltersType2}
          propertyAirFiltersType3={propertyAirFiltersType3}
          filterSizeOptions={filterSizeOptions}
          onSubmit={handleSubmit}
          onCancel={() => router.push('/')}
          inspectionRecordId={inspectionId}
          inspectionExternalId={inspection.inspectionIdExternal}
          pdfUrl={shareLinks?.report || inspection.pdfUrl || undefined}
          existingAnswers={existingAnswers}
          readOnly={readOnly}
          onCancelInspection={readOnly ? undefined : handleCancelInspection}
        />
        </>
      )}
      </div>
    </>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {children}
      </div>
    </main>
  );
}

/**
 * Drop-down menu listing all PDFs generated for a completed Rate Card
 * inspection. Renders nothing if no PDFs are stored on the inspection record
 * (e.g., inspection was completed before Phase 4 shipped or finalize failed
 * to write the URLs back). Vendor PDFs come out of pdf_vendor_urls_json
 * which is `{ vendorName: url, ... }`.
 */
function CompletedPdfMenu({ inspection, shareLinks }: { inspection: InspectionSummary; shareLinks: ShareLinks | null }) {
  const [open, setOpen] = useState(false);
  // Parse vendor URLs JSON (forgiving — if it's blank or malformed, treat as none)
  const vendorUrls = useMemo<Record<string, string>>(() => {
    if (!inspection.pdfVendorUrlsJson) return {};
    try {
      const parsed = JSON.parse(inspection.pdfVendorUrlsJson);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  }, [inspection.pdfVendorUrlsJson]);

  // Prefer the clean short links (resolve to the real file); fall back to the
  // raw stored URL if a short link isn't available for some reason.
  const links: Array<{ label: string; url: string; primary?: boolean }> = [];
  if (inspection.pdfMasterUrl) {
    links.push({ label: 'Master Report', url: shareLinks?.master || inspection.pdfMasterUrl, primary: true });
  }
  if (inspection.pdfChargebackUrl) {
    links.push({ label: 'Tenant Chargeback (PDF)', url: shareLinks?.chargeback || inspection.pdfChargebackUrl });
  }
  if (inspection.pdfChargebackXlsxUrl) {
    links.push({ label: 'Tenant Chargeback Import (xlsx)', url: shareLinks?.xlsx || inspection.pdfChargebackXlsxUrl });
  }
  for (const [vendor, url] of Object.entries(vendorUrls)) {
    if (url) links.push({ label: `Vendor — ${vendor}`, url: shareLinks?.vendors?.[vendor] || url });
  }

  // No PDFs at all? Don't render the menu (avoids confusion). The Reopen
  // button still shows so the user can regenerate by re-running finalize.
  if (links.length === 0) return null;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm bg-brand hover:bg-brand-dark text-white px-3 py-1.5 rounded-lg font-heading font-semibold"
      >
        Download PDFs ▾
      </button>
      {open && (
        <>
          {/* Click-away mask — closing the menu when the user clicks anywhere else */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-40 bg-white border border-gray-200 rounded-lg shadow-lg min-w-[260px] py-1">
            <button
              type="button"
              onClick={async () => {
                setOpen(false);
                // Sequential blob-fetch downloads. Cross-origin URLs (HubSpot
                // Files) ignore <a download> when used directly, so we fetch
                // each PDF as a blob first then save the blob. This forces a
                // download rather than a navigation regardless of the
                // server's Content-Disposition headers.
                for (const l of links) {
                  try {
                    const res = await fetch(l.url);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const blob = await res.blob();
                    const objectUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = objectUrl;
                    // Best-effort filename: last URL path segment (HubSpot
                    // Files URLs include the original filename here).
                    try {
                      const u = new URL(l.url);
                      a.download = decodeURIComponent(u.pathname.split('/').pop() || `${l.label}.pdf`);
                    } catch {
                      a.download = `${l.label}.pdf`;
                    }
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                  } catch (e) {
                    console.error('[CompletedPdfMenu] download failed, opening in tab:', e);
                    window.open(l.url, '_blank', 'noopener,noreferrer');
                  }
                  // small gap between downloads so the browser registers each
                  // as a separate event (helps Chrome's UI counter)
                  await new Promise((r) => setTimeout(r, 250));
                }
              }}
              className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 border-b border-gray-200"
            >
              <span>↓ Download All ({links.length})</span>
            </button>
            {links.map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className={
                  'flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-50 ' +
                  (l.primary ? 'text-brand font-semibold' : 'text-gray-700')
                }
              >
                <span className="truncate pr-2">{l.label}</span>
                <span className="text-xs opacity-70 whitespace-nowrap">↓</span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

