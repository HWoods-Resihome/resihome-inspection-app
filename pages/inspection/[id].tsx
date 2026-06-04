import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useAppDialog } from '@/components/AppDialog';
import type {
  Question, AnswerInput, TemplateType, InspectionSummary,
} from '@/lib/types';
import type { SavedAnswer } from '@/lib/hubspot';
import { QuestionForm } from '@/components/QuestionForm';
import { RateCardForm } from '@/components/RateCardForm';
import { QcReinspectForm } from '@/components/QcReinspectForm';
import { templateLabel as templateLabelFor } from '@/lib/templateLabels';

type Stage = 'loading' | 'loading_questions' | 'form' | 'submitting' | 'generating_pdf' | 'done' | 'error';

interface ShareLinks {
  master: string | null;
  chargeback: string | null;
  xlsx: string | null;
  report: string | null;
  vendors: Record<string, string>;
}

export default function ExistingInspection() {
  const dialog = useAppDialog();
  const router = useRouter();
  const idParam = router.query.id;
  const inspectionId = typeof idParam === 'string' ? idParam : '';

  const [stage, setStage] = useState<Stage>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Logged-in user's email — used to mirror the server's self-approval lockout
  // in the UI (the submitter can't finalize their own submission for 5 min).
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.email) setCurrentUserEmail(String(d.email)); })
      .catch(() => { /* non-fatal: lockout still enforced server-side */ });
    return () => { cancelled = true; };
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
  const [filterSizeOptions, setFilterSizeOptions] = useState<string[]>([]);
  const [existingAnswers, setExistingAnswers] = useState<SavedAnswer[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [submitResultUrl, setSubmitResultUrl] = useState<string>('');
  const [pdfUrl, setPdfUrl] = useState<string>('');
  // Clean short links (resolve to the real files) for downloads — covers all
  // templates. Computed server-side; null until loaded.
  const [shareLinks, setShareLinks] = useState<ShareLinks | null>(null);

  // Load inspection + answers
  useEffect(() => {
    if (!inspectionId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/inspections/${inspectionId}`);
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
        if (cancelled) return;
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
        setFilterSizeOptions(Array.isArray(data.filterSizeOptions) ? data.filterSizeOptions : []);
        setExistingAnswers(data.answers || []);

        // Now load the template questions
        const tmpl = data.inspection.templateType;
        if (!tmpl) {
          setErrorMsg('Inspection has no template type set');
          setStage('error');
          return;
        }
        // Rate Card doesn't use questions — its content comes from the catalog
        // via RateCardForm. Skip the questions fetch and go straight to the form.
        if (tmpl === 'pm_scope_rate_card') {
          setQuestions([]);
          setStage('form');
          return;
        }
        // QC Turn Re-Inspect loads its own data (copied lines + before/after
        // photos) via /api/inspections/[id]/qc-data, so it skips questions too.
        if (tmpl === 'pm_turn_reinspect_qc') {
          setQuestions([]);
          setStage('form');
          return;
        }
        setStage('loading_questions');
        const qr = await fetch(`/api/questions?template=${encodeURIComponent(tmpl)}`);
        const qData = await qr.json();
        if (!qr.ok || qData.error) throw new Error(qData.error || `Questions HTTP ${qr.status}`);
        if (cancelled) return;
        setQuestions(qData.questions || []);
        setStage('form');
      } catch (e: any) {
        if (cancelled) return;
        setErrorMsg(String(e.message || e));
        setStage('error');
      }
    })();
    return () => { cancelled = true; };
  }, [inspectionId]);

  async function handleSubmit(answers: AnswerInput[], sectionPhotoUrls: Record<string, string[]>) {
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
        body: JSON.stringify({ totalQuestionsAnswered, totalPhotos }),
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
      setSubmitResultUrl(data.hubspotUrl || '');

      setStage('generating_pdf');
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
          completedAt: new Date().toISOString(),
          answers,
          sectionPhotoUrls,
        };
        const pdfResp = await fetch('/api/pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pdfReq),
        });
        if (pdfResp.ok) {
          const pdfData = await pdfResp.json();
          if (pdfData.pdfUrl) setPdfUrl(pdfData.pdfUrl);
        }
      } catch (e) {
        console.warn('PDF generation failed (non-fatal):', e);
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
            Back to inspections list
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

  if (stage === 'done') {
    return (
      <Layout>
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-sm text-green-800 mb-3">
          <div className="font-heading font-bold text-lg mb-2">Inspection submitted</div>
          <div className="mb-3">This Inspection is now marked Completed in HubSpot.</div>
          {submitResultUrl && (
            <a href={submitResultUrl} target="_blank" rel="noreferrer" className="text-brand underline block mb-2">
              View in HubSpot
            </a>
          )}
          {pdfUrl && (
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="text-brand underline block">
              View PDF report
            </a>
          )}
          <button onClick={() => router.push('/?just_submitted=1')} className="mt-4 bg-brand text-white font-heading font-semibold px-4 py-2 rounded-lg">
            Back to inspections list
          </button>
        </div>
      </Layout>
    );
  }

  // stage === 'form'
  if (!inspection) return null;
  const isCompleted = (inspection.status || '').toLowerCase() === 'completed';
  const isCancelled = (inspection.status || '').toLowerCase() === 'cancelled';
  const readOnly = isCompleted || isCancelled;
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
      {readOnly && (
        <div className="bg-amber-50 border-b border-amber-200 py-2">
          {/* Symmetrical 3-zone header, aligned to the same max-width container
              as the page content below: status (left) · downloads (center) ·
              Re-Open (right). */}
          <div className="max-w-7xl mx-auto px-5 sm:px-6 flex items-center justify-between gap-3 flex-wrap">
            {/* Left: status */}
            <span className="text-sm text-amber-900 font-heading font-semibold">
              {isCompleted ? 'This Inspection is Completed.' : 'This Inspection is Cancelled.'}
            </span>

            {/* Center: download options (brand-colored to match the scheme) */}
            <div className="flex items-center justify-center gap-2 flex-wrap">
              {isCompleted && inspection.templateType === 'pm_scope_rate_card' && (
                <CompletedPdfMenu inspection={inspection} shareLinks={shareLinks} />
              )}
              {isCompleted && inspection.templateType === 'pm_turn_reinspect_qc' && inspection.pdfUrl && (
                <a href={shareLinks?.report || inspection.pdfUrl} target="_blank" rel="noopener noreferrer"
                   className="text-sm bg-brand hover:bg-brand-dark text-white font-heading font-semibold px-3 py-1.5 rounded-lg">
                  Download QC Report (PDF)
                </a>
              )}
              {isCompleted && inspection.templateType !== 'pm_scope_rate_card'
                && inspection.templateType !== 'pm_turn_reinspect_qc' && inspection.pdfUrl && (
                <a href={shareLinks?.report || inspection.pdfUrl} target="_blank" rel="noopener noreferrer"
                   className="text-sm bg-brand hover:bg-brand-dark text-white font-heading font-semibold px-3 py-1.5 rounded-lg">
                  Download Report (PDF)
                </a>
              )}
            </div>

            {/* Right: Re-Open for Edits (secondary, outlined) */}
            {isCompleted ? (
              <button
                onClick={handleReopen}
                className="text-sm text-brand border border-brand hover:bg-brand/5 font-heading font-semibold px-3 py-1.5 rounded-lg"
              >
                Re-Open for Edits
              </button>
            ) : <span />}
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
          approverName={inspection.approvedByName}
          approvedAt={inspection.approvedAt}
          propertyName={propertyName}
          bedrooms={inspection.bedroomsAtInspection || 0}
          bathrooms={inspection.bathroomsAtInspection || 0}
          squareFootage={propertySquareFootage}
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
          onSubmit={handleSubmit}
          onCancel={() => router.push('/')}
          inspectionRecordId={inspectionId}
          inspectionExternalId={inspection.inspectionIdExternal}
          pdfUrl={shareLinks?.report || inspection.pdfUrl || undefined}
          existingAnswers={existingAnswers}
          readOnly={readOnly}
          onCancelInspection={readOnly ? undefined : handleCancelInspection}
        />
      )}
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

