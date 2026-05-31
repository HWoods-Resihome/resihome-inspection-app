import { useEffect, useState } from 'react';
import type { Question, AnswerInput } from '@/lib/types';
import { CameraCapture } from './CameraCapture';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { useAppDialog } from '@/components/AppDialog';
import { displayImageSrc } from '@/lib/photoDisplay';
import { isVideoEntry } from '@/lib/media';

// Check once whether the browser supports the camera API. Hidden behind a
// constant so the "Take Photos" button can be disabled on unsupported browsers
// without throwing on the server during SSR.
const hasMediaDevices = typeof navigator !== 'undefined'
  && !!navigator.mediaDevices?.getUserMedia;

type Props = {
  question: Question;
  answer: AnswerInput;
  onUpdate: (patch: Partial<AnswerInput>) => void;
  uploadPhoto: (file: File) => Promise<string>;
  propertyName?: string;
  propertyRecordId?: string;
};

export function QuestionItem({ question, answer, onUpdate, uploadPhoto, propertyName, propertyRecordId }: Props) {
  const dialog = useAppDialog();
  const triggered = !!answer.answerValue && question.noteRequiredOnValues.includes(answer.answerValue);

  // Optional panel is open if:
  //  - inspector explicitly opened it, OR
  //  - answer is triggered (action required), OR
  //  - panel already has content (note/photos/quantity)
  const hasContent = !!answer.note || answer.photoUrls.length > 0 || answer.quantity != null;
  const panelOpen = answer.optionalPanelOpen || triggered || hasContent;

  // Auto-default assignedTo to "Vendor 1" when the question supports it and is triggered.
  // Inspector can change to other vendors via the dropdown.
  useEffect(() => {
    if (triggered && question.hasAssignedTo && !answer.assignedTo) {
      onUpdate({ assignedTo: 'Vendor 1' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggered, question.hasAssignedTo]);

  // Upload progress: { current, total } while uploading; null when idle
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Replace a photo with its marked-up version (re-upload + swap at index).
  async function replacePhoto(index: number, file: File) {
    try {
      const url = await uploadPhoto(file);
      const arr = [...answer.photoUrls];
      if (index < 0 || index >= arr.length) return;
      arr[index] = url;
      onUpdate({ photoUrls: arr });
    } catch (e) {
      console.error('[QuestionItem] photo replace failed:', e);
    }
  }

  async function handlePhotoUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const fileArr = Array.from(files);
    setUploadProgress({ current: 0, total: fileArr.length });

    // Track URLs as they come in. We send the cumulative list to the parent on
    // each completion so the parent's reducer always sees the latest state.
    const startingUrls = [...answer.photoUrls];
    const newUrls: string[] = [];
    let failed = 0;

    const CONCURRENCY = 3;
    let next = 0;
    let completed = 0;

    async function worker() {
      while (next < fileArr.length) {
        const idx = next++;
        try {
          const url = await uploadPhoto(fileArr[idx]);
          newUrls.push(url);
          // Send accumulated list to parent so the thumbnail appears immediately
          onUpdate({ photoUrls: [...startingUrls, ...newUrls] });
        } catch (e) {
          console.error(`Photo upload ${idx + 1} failed:`, e);
          failed++;
        }
        completed++;
        setUploadProgress({ current: completed, total: fileArr.length });
      }
    }

    try {
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, fileArr.length) },
        () => worker()
      );
      await Promise.all(workers);
      if (failed > 0) {
        void dialog.alert(
          `${failed} of ${fileArr.length} photo${fileArr.length === 1 ? '' : 's'} failed to upload. ` +
          `Photos that succeeded have been saved.`
        );
      }
    } catch (e: any) {
      void dialog.alert(`Photo upload failed: ${e.message || e}`);
    } finally {
      setUploadProgress(null);
    }
  }

  function removePhoto(idx: number) {
    onUpdate({ photoUrls: answer.photoUrls.filter((_, i) => i !== idx) });
  }

  function togglePanel() {
    onUpdate({ optionalPanelOpen: !panelOpen });
  }

  return (
    <div className="p-4" data-question-id={question.questionIdExternal}>
      {/* Question text + Notes/Photos toggle button */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <label className="block font-heading font-semibold text-ink text-sm flex-1">
          {question.questionText}
          {question.isRequired && <span className="text-brand ml-1">*</span>}
        </label>
        <button
          type="button"
          onClick={togglePanel}
          aria-label={panelOpen ? 'Close notes/photos' : 'Add notes/photos'}
          aria-expanded={panelOpen}
          title={panelOpen ? 'Close notes/photos' : 'Add notes/photos (optional)'}
          className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-heading font-semibold transition ${
            panelOpen
              ? 'bg-gray-700 text-white hover:bg-gray-800'
              : 'bg-gray-100 text-gray-600 hover:bg-brand/10 hover:text-brand'
          } ${hasContent && !panelOpen ? 'ring-2 ring-brand/40' : ''}`}
        >
          {/* Camera + pencil glyph combo */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="6" width="14" height="11" rx="2" />
            <circle cx="9" cy="11.5" r="2.2" />
            <path d="M5.5 6L6.5 4h5L12.5 6" />
            <path d="M18 9l3.5 3.5L19 21l-4 1 1-4 6.5-6.5z" transform="scale(0.7) translate(8 6)" />
          </svg>
          <span>Notes/Photos</span>
        </button>
      </div>

      {question.helpText && (
        <p className="text-xs text-gray-500 mb-2 italic line-clamp-2" title={question.helpText}>
          {question.helpText}
        </p>
      )}

      {renderInput(question, answer, onUpdate)}

      {/* Combined notes/photos panel */}
      {panelOpen && (
        <div className={`mt-3 p-3 rounded-lg space-y-3 border ${
          triggered ? 'bg-amber-50 border-amber-300' : 'bg-gray-50 border-gray-200'
        }`}>
          <div className="flex items-center justify-between">
            <span className={`text-xs font-heading font-bold uppercase tracking-wider ${
              triggered ? 'text-amber-900' : 'text-gray-600'
            }`}>
              {triggered ? 'Action required' : 'Optional notes & photos'}
            </span>
            {!triggered && (
              <button
                type="button"
                onClick={togglePanel}
                className="text-xs text-gray-500 hover:text-ink underline"
              >
                close
              </button>
            )}
          </div>

          {/* Note (shared field, required if triggered) */}
          <div>
            <label className={`block text-xs font-heading font-semibold mb-1 ${
              triggered ? 'text-amber-900' : 'text-gray-700'
            }`}>
              Note {triggered ? <span className="text-brand">(required)</span> : <span className="text-gray-400 font-normal">(optional)</span>}
            </label>
            <textarea
              value={answer.note || ''}
              onChange={(e) => onUpdate({ note: e.target.value })}
              rows={2}
              placeholder={triggered ? 'Describe the issue or action needed' : 'Add a note for this question'}
              className={`focus-brand w-full text-sm rounded-md px-2 py-1.5 bg-white border ${
                triggered ? 'border-amber-300' : 'border-gray-300'
              }`}
            />
          </div>

          {/* Assigned To: visible when triggered AND the question supports it (has_assigned_to=true).
              Ordered ABOVE Quantity per Hayden's request. */}
          {triggered && question.hasAssignedTo && (() => {
            // Build the visible options list:
            //   1) Start from question.assignedToOptions (HubSpot data) OR the hardcoded fallback
            //   2) Strip "None" (case-insensitive) - it's not a valid action assignment
            //   3) Ensure "Vendor 1" is the first option if present (Hayden's default)
            const rawOptions = question.assignedToOptions.length > 0
              ? question.assignedToOptions
              : ['Vendor 1', 'Vendor 2', 'Internal Resolution'];
            const filtered = rawOptions.filter((o) => o.trim().toLowerCase() !== 'none');
            const vendor1Idx = filtered.findIndex((o) => o.trim().toLowerCase() === 'vendor 1');
            const cleanedOptions = vendor1Idx > 0
              ? ['Vendor 1', ...filtered.slice(0, vendor1Idx), ...filtered.slice(vendor1Idx + 1)]
              : filtered;
            return (
              <div>
                <label className="block text-xs font-heading font-semibold text-amber-900 mb-1">
                  Assigned to <span className="text-brand">(required)</span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {cleanedOptions.map((opt) => {
                    const selected = (answer.assignedTo || 'Vendor 1') === opt;
                    return (
                      <button
                        type="button"
                        key={opt}
                        onClick={() => onUpdate({ assignedTo: opt })}
                        className={`text-xs font-heading font-semibold px-3 py-1.5 rounded-full border-2 transition whitespace-nowrap ${
                          selected
                            ? 'bg-brand text-white border-brand shadow-sm'
                            : 'bg-white text-ink border-amber-300 hover:border-brand/50'
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Photos */}
          <div>
            <label className={`block text-xs font-heading font-semibold mb-1 ${
              triggered ? 'text-amber-900' : 'text-gray-700'
            }`}>
              Photos <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <div className="flex flex-wrap gap-2 items-center">
              {/* Take Photos: in-app camera */}
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                disabled={!!uploadProgress || !hasMediaDevices}
                className="inline-flex items-center gap-1.5 text-sm bg-brand text-white font-heading font-semibold py-1.5 px-3 rounded hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed"
                title={hasMediaDevices ? 'Take photos with the in-app camera' : 'Camera not supported in this browser'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                Take Photos
              </button>
              {/* Choose Files: existing native file input */}
              <label className="inline-flex items-center gap-1.5 text-sm bg-brand/10 text-brand font-heading font-semibold py-1.5 px-3 rounded cursor-pointer hover:bg-brand/20">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                Choose Files
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => handlePhotoUpload(e.target.files)}
                  disabled={!!uploadProgress}
                  className="hidden"
                />
              </label>
            </div>
            {uploadProgress && (
              <div className="text-xs text-brand mt-1 font-heading font-semibold">
                Uploading {uploadProgress.current} of {uploadProgress.total}...
              </div>
            )}
            <CameraCapture
              isOpen={cameraOpen}
              addressSnapshot={propertyName}
              propertyRecordId={propertyRecordId}
              onClose={() => setCameraOpen(false)}
              uploadPhoto={uploadPhoto}
              onComplete={(urls) => {
                setCameraOpen(false);
                if (urls.length > 0) {
                  onUpdate({ photoUrls: [...answer.photoUrls, ...urls] });
                }
              }}
            />
            {answer.photoUrls.length > 0 && (
              <div className="grid grid-cols-4 gap-2 mt-2">
                {answer.photoUrls.map((url, idx) => (
                  <div key={`${url}-${idx}`} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={displayImageSrc(url)}
                      alt=""
                      onClick={() => setLightboxIndex(idx)}
                      className="w-full h-16 object-cover rounded cursor-pointer"
                    />
                    {isVideoEntry(url) && (
                      <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <span className="w-6 h-6 rounded-full bg-black/55 flex items-center justify-center">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                        </span>
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removePhoto(idx)}
                      className="absolute -top-1 -right-1 bg-ink text-white text-xs w-5 h-5 rounded-full leading-none flex items-center justify-center hover:bg-brand transition"
                    >&times;</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {lightboxIndex !== null && answer.photoUrls.length > 0 && (
        <PhotoLightbox
          groups={[{ id: 'q', name: 'Photos' }]}
          photosByGroup={{ q: answer.photoUrls }}
          initialGroupId="q"
          initialIndex={Math.min(lightboxIndex, answer.photoUrls.length - 1)}
          onClose={() => setLightboxIndex(null)}
          onDelete={(_g, i) => removePhoto(i)}
          onReplace={(_g, i, file) => replacePhoto(i, file)}
        />
      )}
    </div>
  );
}

function renderInput(
  q: Question,
  a: AnswerInput,
  onUpdate: (patch: Partial<AnswerInput>) => void
) {
  // BUTTON-PILL FOR ALL PICKLIST-TYPE INPUTS (single_select, boolean) regardless of count.
  // Long picklists (Closet, Drywall etc.) wrap freely.
  if (q.responseType === 'single_select' || q.responseType === 'boolean') {
    const opts = q.responseOptions.length > 0
      ? q.responseOptions
      : (q.responseType === 'boolean' ? ['Yes', 'No'] : []);
    if (opts.length === 0) {
      return <div className="text-xs text-brand">(no options defined)</div>;
    }
    // Compact pill style. Same size regardless of option count for consistent look.
    return (
      <div className="flex flex-wrap gap-1.5">
        {opts.map((opt) => {
          const selected = a.answerValue === opt;
          return (
            <button
              type="button"
              key={opt}
              onClick={() => onUpdate({ answerValue: opt })}
              className={`text-xs font-heading font-semibold px-3 py-1.5 rounded-full border-2 transition whitespace-nowrap ${
                selected
                  ? 'bg-brand text-white border-brand shadow-sm'
                  : 'bg-white text-ink border-gray-300 hover:border-brand/50'
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    );
  }

  if (q.responseType === 'text') {
    return (
      <textarea
        value={a.answerValue}
        onChange={(e) => onUpdate({ answerValue: e.target.value })}
        rows={2}
        className="focus-brand w-full text-sm border border-gray-300 rounded-md px-2 py-1.5"
      />
    );
  }

  if (q.responseType === 'number') {
    return (
      <input
        type="number"
        value={a.answerValue}
        onChange={(e) => onUpdate({ answerValue: e.target.value })}
        className="focus-brand w-32 text-sm border border-gray-300 rounded-md px-2 py-1.5"
      />
    );
  }

  if (q.responseType === 'date') {
    return (
      <input
        type="date"
        value={a.answerValue}
        onChange={(e) => onUpdate({ answerValue: e.target.value })}
        className="focus-brand text-sm border border-gray-300 rounded-md px-2 py-1.5"
      />
    );
  }

  return (
    <div className="text-xs text-gray-400 italic">
      ({q.responseType}) -- input type not yet implemented
    </div>
  );
}
