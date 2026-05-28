import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import type {
  Question, AnswerInput, TemplateType, InspectionSummary,
} from '@/lib/types';
import type { SavedAnswer } from '@/lib/hubspot';
import { QuestionForm } from '@/components/QuestionForm';
import { RateCardForm } from '@/components/RateCardForm';

const TEMPLATE_LABELS: Record<string, string> = {
  pm_scope_inspection: '(PM) Scope Inspection',
  pm_scope_rate_card: '(PM) Scope Rate Card',
  pm_turn_inspection: '(PM) Turn Inspection',
  pm_community_inspection: '(PM) Community / Visit Inspection',
  pm_vacancy_occupancy_check: '(PM) Vacancy / Occupancy Check',
  qc_new_construction_rrqc: '(QC) New Construction RRQC',
  leasing_agent_1099_property_inspection: '1099 Leasing Agent Property Inspection',
};

type Stage = 'loading' | 'loading_questions' | 'form' | 'submitting' | 'generating_pdf' | 'done' | 'error';

export default function ExistingInspection() {
  const router = useRouter();
  const idParam = router.query.id;
  const inspectionId = typeof idParam === 'string' ? idParam : '';

  const [stage, setStage] = useState<Stage>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [inspection, setInspection] = useState<InspectionSummary | null>(null);
  const [propertyRecordId, setPropertyRecordId] = useState<string>('');
  const [propertySquareFootage, setPropertySquareFootage] = useState<number | null>(null);
  const [existingAnswers, setExistingAnswers] = useState<SavedAnswer[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [submitResultUrl, setSubmitResultUrl] = useState<string>('');
  const [pdfUrl, setPdfUrl] = useState<string>('');

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
        setPropertyRecordId(data.propertyRecordId || '');
        setPropertySquareFootage(
          typeof data.propertySquareFootage === 'number' ? data.propertySquareFootage : null
        );
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
          templateLabel: TEMPLATE_LABELS[inspection.templateType] || inspection.templateType,
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
    if (!confirm('Mark this Inspection as Cancelled? This will preserve all current answers but flag the Inspection as cancelled in HubSpot.')) return;
    try {
      const r = await fetch(`/api/inspections/${inspectionId}/cancel`, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      router.push('/?just_cancelled=1');
    } catch (e: any) {
      alert(`Cancel failed: ${e.message || e}`);
    }
  }

  async function handleReopen() {
    if (!confirm('Reopen this completed inspection for editing? Status will change back to In Progress.')) return;
    try {
      const r = await fetch(`/api/inspections/${inspectionId}/reopen`, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      // Refresh
      window.location.reload();
    } catch (e: any) {
      alert(`Reopen failed: ${e.message || e}`);
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
  const templateLabel = TEMPLATE_LABELS[inspection.templateType] || inspection.templateType;

  return (
    <>
      <Head>
        <title>{inspection.propertyAddressSnapshot || 'Inspection'} - ResiHome</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </Head>
      {readOnly && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-center">
          <span className="text-sm text-amber-900 font-heading font-semibold">
            {isCompleted ? 'This Inspection is Completed.' : 'This Inspection is Cancelled.'}
          </span>
          {isCompleted && (
            <button onClick={handleReopen} className="ml-3 text-sm text-brand underline font-semibold">
              Reopen for editing
            </button>
          )}
        </div>
      )}
      {inspection.templateType === 'pm_scope_rate_card' ? (
        <RateCardForm
          templateType={inspection.templateType as TemplateType}
          templateLabel={templateLabel}
          inspectorName={inspection.inspectorName}
          propertyName={inspection.propertyAddressSnapshot || `Property ${propertyRecordId}`}
          bedrooms={inspection.bedroomsAtInspection || 0}
          bathrooms={inspection.bathroomsAtInspection || 0}
          squareFootage={propertySquareFootage}
          inspectionRegion={inspection.regionSnapshot || ''}
          sectionListJson={inspection.sectionListJson}
          onSubmit={() => handleSubmit([], {})}
          onCancel={() => router.push('/')}
          inspectionRecordId={inspectionId}
          inspectionExternalId={inspection.inspectionIdExternal}
          pdfUrl={inspection.pdfUrl || undefined}
          readOnly={readOnly}
          onCancelInspection={readOnly ? undefined : handleCancelInspection}
        />
      ) : (
        <QuestionForm
          questions={questions}
          templateType={inspection.templateType as TemplateType}
          templateLabel={templateLabel}
          inspectorName={inspection.inspectorName}
          propertyName={inspection.propertyAddressSnapshot || `Property ${propertyRecordId}`}
          bedrooms={inspection.bedroomsAtInspection || 0}
          bathrooms={inspection.bathroomsAtInspection || 0}
          squareFootage={propertySquareFootage}
          inspectionRegion={inspection.regionSnapshot || ''}
          onSubmit={handleSubmit}
          onCancel={() => router.push('/')}
          inspectionRecordId={inspectionId}
          inspectionExternalId={inspection.inspectionIdExternal}
          pdfUrl={inspection.pdfUrl}
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
