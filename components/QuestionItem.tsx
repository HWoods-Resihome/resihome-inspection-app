import { useEffect, useState } from 'react';
import type { Question, AnswerInput } from '@/lib/types';
import { CameraCapture } from './CameraCapture';
import { ListPicker } from '@/components/ListPicker';
import { NumberField } from '@/components/NumberPad';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { useAppDialog } from '@/components/AppDialog';
import { displayImageSrc } from '@/lib/photoDisplay';
import { useAnyCameraOpen } from '@/lib/cameraOpenState';
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
  /** Scope-Rate-Card-style: Action Required uses a white background with an amber
   *  border (no yellow fill) and photos use a single in-app "Take" button (no
   *  separate Choose Files). Used by the 1099 / occupancy / community templates. */
  plainStyle?: boolean;
  /** Render the Photos block ABOVE the Note block in the panel. */
  photoFirst?: boolean;
  /** Shrink answer pills so long sets (e.g. Good - No Issues / Fail - Needs
   *  Attention / N/A) fit on one line on mobile. */
  compactOptions?: boolean;
};

export function QuestionItem({ question, answer, onUpdate, uploadPhoto, propertyName, propertyRecordId, plainStyle, photoFirst, compactOptions }: Props) {
  const dialog = useAppDialog();
  // A note is required when the selected value is explicitly configured
  // (noteRequiredOnValues) OR — robust to the Good/Fail relabel — when a
  // "Fail …" answer is picked and this question requires a note on its fail value.
  // "N/A" answers never require a note/photo and never open the panel, even when
  // the question is flagged Require note / Require photo.
  const naSelected = isNA(answer.answerValue);
  const failSelected = answerTone(answer.answerValue) === 'fail';
  const triggered = !!answer.answerValue && !naSelected && (
    question.noteRequiredOnValues.includes(answer.answerValue)
    || (failSelected && question.noteRequiredOnValues.some((v) => answerTone(v) === 'fail'))
  );
  // Form-builder "Require note" / "Require photo": once a (non-N/A) answer is
  // picked, force the panel open so the inspector can add the required note/photo.
  const noteRequired = !!question.requiresNote && !!answer.answerValue && !naSelected;
  const photoRequired = !!question.requiresPhoto && !!answer.answerValue && !naSelected;
  const noteMandatory = triggered || noteRequired;
  // The panel is forced open (and the Notes/Photos toggle hidden) when an answer
  // demands a note or a photo. Deselect / switch back to a non-triggering answer
  // and the optional Notes/Photos toggle returns.
  const forcedOpen = triggered || noteRequired || photoRequired;

  // Optional panel is open if:
  //  - it's forced open (action required / photo required), OR
  //  - inspector explicitly opened it, OR
  //  - panel already has content (note/photos/quantity)
  const hasContent = !!answer.note || answer.photoUrls.length > 0 || answer.quantity != null;
  const panelOpen = answer.optionalPanelOpen || forcedOpen || hasContent;

  // Auto-default assignedTo to "Vendor 1" when the question supports it and is
  // triggered. Skipped for plainStyle (1099/occupancy/community) templates —
  // vendor assignment is strictly a Scope Rate Card concept there.
  useEffect(() => {
    if (!plainStyle && triggered && question.hasAssignedTo && !answer.assignedTo) {
      onUpdate({ assignedTo: 'Vendor 1' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggered, question.hasAssignedTo]);

  // Upload progress: { current, total } while uploading; null when idle
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // While ANY camera overlay is open, don't render this question's photo
  // thumbnails — they're invisible behind the camera and keeping them decoded
  // is what OOM-crashes iOS WebKit after a shot or two. They re-render on close.
  const cameraOpenAnywhere = useAnyCameraOpen();

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

  // photo_only: the photo capture IS the answer (e.g. HVAC label-sticker shots).
  // Render a streamlined required-photo block — no value input, no panel toggle.
  if (question.responseType === 'photo_only') {
    return (
      <div className="p-4" data-question-id={question.questionIdExternal}>
        <label className="block font-heading font-semibold text-ink text-sm mb-1">
          {question.questionText}
          {question.isRequired && <span className="text-brand ml-1">*</span>}
        </label>
        {question.helpText && (
          <p className="text-xs text-gray-500 mb-2 italic">{question.helpText}</p>
        )}
        <div className="flex flex-wrap gap-2 items-center">
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
          {!plainStyle && (
            <label className="inline-flex items-center gap-1.5 text-sm bg-brand/10 text-brand font-heading font-semibold py-1.5 px-3 rounded cursor-pointer hover:bg-brand/20">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Choose Files
              <input type="file" accept="image/*" multiple className="hidden"
                onChange={(e) => handlePhotoUpload(e.target.files)} disabled={!!uploadProgress} />
            </label>
          )}
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
            if (urls.length > 0) onUpdate({ photoUrls: [...answer.photoUrls, ...urls] });
          }}
        />
        {answer.photoUrls.length > 0 && !cameraOpenAnywhere && (
          <div className="grid grid-cols-4 gap-2 mt-2">
            {answer.photoUrls.map((url, idx) => (
              <div key={`${url}-${idx}`} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={displayImageSrc(url)} alt="" loading="lazy" decoding="async" onClick={() => setLightboxIndex(idx)}
                  className="w-full h-16 object-cover rounded cursor-pointer" />
                {url.startsWith('blob:') && (
                  <span className="absolute bottom-0 inset-x-0 bg-amber-500/95 text-white text-[8px] font-heading font-bold text-center leading-tight py-0.5 rounded-b pointer-events-none" title="Saved Offline · Will Sync When Online">Saved Offline</span>
                )}
                <button type="button" onClick={() => removePhoto(idx)}
                  className="absolute -top-1 -right-1 bg-ink text-white text-xs w-5 h-5 rounded-full leading-none flex items-center justify-center hover:bg-brand transition">&times;</button>
              </div>
            ))}
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

  return (
    <div className="p-4" data-question-id={question.questionIdExternal}>
      {/* Question text + Notes/Photos toggle button */}
      <div className="flex items-center justify-between gap-3 mb-2">
        <label className="block font-heading font-semibold text-ink text-sm flex-1">
          {question.questionText}
          {question.isRequired && <span className="text-brand ml-1">*</span>}
        </label>
        {/* Notes/Photos toggle — hidden when the panel is forced open (the
            required note/photo panel already shows). Returns as an optional add
            once the answer no longer requires it. */}
        {!forcedOpen && (
          <button
            type="button"
            onClick={togglePanel}
            aria-label={panelOpen ? 'Close notes/photos' : 'Add notes/photos'}
            aria-expanded={panelOpen}
            title={panelOpen ? 'Close notes/photos' : 'Add notes/photos (Optional)'}
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
        )}
      </div>

      {question.helpText && (
        <p className="text-xs text-gray-500 mb-2 italic line-clamp-2" title={question.helpText}>
          {question.helpText}
        </p>
      )}

      {renderInput(question, answer, onUpdate, compactOptions)}

      {/* Combined notes/photos panel */}
      {panelOpen && (
        <div className={`mt-3 p-3 rounded-lg flex flex-col gap-3 ${
          forcedOpen
            ? (plainStyle ? 'bg-white border-2 border-amber-300' : 'bg-amber-50 border border-amber-300')
            : 'bg-gray-50 border border-gray-200'
        }`}>
          <div className="flex items-center justify-between">
            <span className={`text-xs font-heading font-bold uppercase tracking-wider ${
              forcedOpen ? 'text-amber-900' : 'text-gray-600'
            }`}>
              {triggered ? 'Action required'
                : (noteRequired && photoRequired) ? 'Note & photo required'
                : noteRequired ? 'Note required'
                : photoRequired ? 'Photo required'
                : 'Optional notes & photos'}
            </span>
            {!forcedOpen && (
              <button
                type="button"
                onClick={togglePanel}
                className="text-xs text-gray-500 hover:text-ink underline"
              >
                close
              </button>
            )}
          </div>

          {/* Note (shared field, required when triggered or "Require note" is set) */}
          <div className={photoFirst ? 'order-2' : ''}>
            <label className={`block text-xs font-heading font-semibold mb-1 ${
              noteMandatory ? 'text-amber-900' : 'text-gray-700'
            }`}>
              Note {noteMandatory ? <span className="text-brand">(Required)</span> : <span className="text-gray-400 font-normal">(Optional)</span>}
            </label>
            <textarea
              value={answer.note || ''}
              onChange={(e) => onUpdate({ note: e.target.value })}
              rows={2}
              placeholder={noteMandatory ? 'Describe the issue or action needed' : 'Add a note for this question'}
              className={`focus-brand w-full text-sm rounded-md px-2 py-1.5 bg-white border ${
                noteMandatory ? 'border-amber-300' : 'border-gray-300'
              }`}
            />
          </div>

          {/* Assigned To: visible when triggered AND the question supports it
              (has_assigned_to=true). Hidden for plainStyle templates — vendor
              assignment is strictly a Scope Rate Card thing.
              Ordered ABOVE Quantity per Hayden's request. */}
          {!plainStyle && triggered && question.hasAssignedTo && (() => {
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
                  Assigned to <span className="text-brand">(Required)</span>
                </label>
                <ListPicker
                  value={answer.assignedTo || 'Vendor 1'}
                  options={cleanedOptions.map((o) => ({ value: o, label: o }))}
                  onChange={(v) => onUpdate({ assignedTo: v })}
                  ariaLabel="Assigned to"
                  className="w-full sm:w-72 bg-white rounded-lg px-3 py-2.5 text-sm text-ink flex items-center justify-between border-2 border-amber-300"
                />
              </div>
            );
          })()}

          {/* Photos */}
          <div className={photoFirst ? 'order-1' : ''}>
            <label className={`block text-xs font-heading font-semibold mb-1 ${
              forcedOpen ? 'text-amber-900' : 'text-gray-700'
            }`}>
              Photos {photoRequired ? <span className="text-brand">(Required)</span> : <span className="text-gray-400 font-normal">(Optional)</span>}
            </label>
            <div className="flex flex-wrap gap-2 items-center mt-1">
              {/* Existing photos (tap to view / mark up / delete). Hidden while a
                  camera is open to free their decoded memory (iOS crash). */}
              {!cameraOpenAnywhere && answer.photoUrls.map((url, idx) => (
                <div key={`${url}-${idx}`} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={displayImageSrc(url)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onClick={() => setLightboxIndex(idx)}
                    title="Tap to view, mark up, or delete"
                    className="w-14 h-14 object-cover rounded border border-gray-200 cursor-pointer"
                  />
                  {isVideoEntry(url) && (
                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <span className="w-6 h-6 rounded-full bg-black/55 flex items-center justify-center">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                      </span>
                    </span>
                  )}
                  {url.startsWith('blob:') && (
                    <span className="absolute bottom-0 inset-x-0 bg-amber-500/95 text-white text-[8px] font-heading font-bold text-center leading-tight py-0.5 rounded-b pointer-events-none" title="Saved Offline · Will Sync When Online">Saved Offline</span>
                  )}
                  <button
                    type="button"
                    onClick={() => removePhoto(idx)}
                    aria-label="Delete photo"
                    className="absolute -top-1 -right-1 bg-ink text-white text-xs w-4 h-4 rounded-full leading-none flex items-center justify-center hover:bg-brand transition"
                  >&times;</button>
                </div>
              ))}
              {/* Add photo — dashed box + plus (matches the HVAC/air-filter strip).
                  Amber dashed when a photo is required and none yet; grey when optional. */}
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                disabled={!!uploadProgress || !hasMediaDevices}
                aria-label="Add photo"
                title={hasMediaDevices ? 'Take photos with the in-app camera' : 'Camera not supported in this browser'}
                className={`w-14 h-14 rounded-lg border-2 border-dashed flex items-center justify-center text-2xl leading-none disabled:opacity-40 ${
                  photoRequired && answer.photoUrls.length === 0
                    ? 'border-amber-300 text-amber-500'
                    : 'border-gray-300 text-gray-400 hover:border-brand/50 hover:text-brand'
                }`}
              >+</button>
              {/* Choose Files: gallery import as a matching dashed tile. Hidden for
                  plainStyle templates (the in-app camera also covers the gallery). */}
              {!plainStyle && (
                <label
                  title="Choose photos from your device"
                  className="w-14 h-14 rounded-lg border-2 border-dashed border-gray-300 text-gray-400 hover:border-brand/50 hover:text-brand flex items-center justify-center cursor-pointer"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(e) => handlePhotoUpload(e.target.files)}
                    disabled={!!uploadProgress}
                    className="hidden"
                  />
                </label>
              )}
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

// Picklists with this many options or fewer render as quick tap-buttons
// (Yes/No, Good/Fail, Pass/Fail/NA…); longer lists use the ListPicker pop-up.
const PILL_MAX = 4;

// Visual tone for an answer pill: drives the selected fill + icon color.
//   good = emerald green · fail = brand pink · neutral = slate
type PillTone = 'good' | 'fail' | 'neutral';
type PillIconKind = 'thumbUp' | 'thumbDown' | 'arrowUp' | 'arrowDown' | 'flat' | 'house' | 'person' | null;

// A small stroke icon shown at the far left of an answer pill. Inherits white
// when the pill is selected; otherwise tinted to the tone (matching the
// thumbs-up / thumbs-down treatment).
function PillIcon({ icon, tone, selected }: { icon: PillIconKind; tone: PillTone | null; selected: boolean }) {
  if (!icon) return null;
  const color = selected ? 'text-white'
    : tone === 'good' ? 'text-emerald-600'
    : tone === 'neutral' ? 'text-gray-600'
    : 'text-brand';
  let inner: JSX.Element | null = null;
  switch (icon) {
    case 'thumbUp':   inner = <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />; break;
    case 'thumbDown': inner = <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />; break;
    case 'arrowUp':   inner = <><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></>; break;
    case 'arrowDown': inner = <><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></>; break;
    case 'flat':      inner = <line x1="5" y1="12" x2="19" y2="12" />; break;
    case 'house':     inner = <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>; break;
    case 'person':    inner = <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>; break;
  }
  return (
    <svg className={color} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {inner}
    </svg>
  );
}

// Pass/fail tone of an answer label (good = positive, fail = needs attention).
// Drives pill coloring AND lets a "Fail …" answer keep triggering the note panel
// even after the option text was relabeled (e.g. "Fail" → "Fail - Needs Attention").
export function answerTone(opt: string): 'good' | 'fail' | null {
  const n = (opt || '').trim().toLowerCase();
  if (/\b(fail|failed|poor|deficient)\b/.test(n)) return 'fail';
  if (/\b(good|pass|passed|satisfactory)\b/.test(n)) return 'good';
  return null;
}

// "N/A" (and variants) — a not-applicable answer never requires a note or photo,
// even if the question is flagged Require note / Require photo.
export function isNA(opt: string): boolean {
  return /^(n\/?a|n\.a\.?|not applicable)\b/.test((opt || '').trim().toLowerCase());
}

function renderInput(
  q: Question,
  a: AnswerInput,
  onUpdate: (patch: Partial<AnswerInput>) => void,
  compactOptions?: boolean,
) {
  // Picklists: short choice sets (Yes/No, Good/Fail, Pass/Fail/NA, etc.) stay as
  // quick tap-buttons; only LONGER lists use the branded ListPicker pop-up (a
  // pop-up for a 2-3 option toggle would be slower, not faster).
  if (q.responseType === 'single_select' || q.responseType === 'boolean') {
    const opts = q.responseOptions.length > 0
      ? q.responseOptions
      : (q.responseType === 'boolean' ? ['Yes', 'No'] : []);
    if (opts.length === 0) {
      return <div className="text-xs text-brand">(no options defined)</div>;
    }
    if (opts.length > PILL_MAX) {
      return (
        <ListPicker
          value={a.answerValue}
          options={opts.map((o) => ({ value: o, label: o }))}
          onChange={(v) => onUpdate({ answerValue: v })}
          ariaLabel="Select an answer"
          placeholder="Select…"
          className="w-full sm:w-72 bg-gray-100 rounded-lg px-3 py-2.5 text-sm text-ink flex items-center justify-between"
        />
      );
    }
    // Map a short answer label to a tone (selected fill color) + leading icon.
    // Matched on the word anywhere in the label so multi-word options like
    // "Good - No Issues" / "Fail - Needs Attention" still classify.
    const meta = (opt: string): { tone: PillTone | null; icon: PillIconKind } => {
      const n = opt.trim().toLowerCase();
      const t = answerTone(opt);
      if (t === 'fail') return { tone: 'fail', icon: 'thumbDown' };
      if (t === 'good') return { tone: 'good', icon: 'thumbUp' };
      if (/\bincrease\b/.test(n)) return { tone: 'good', icon: 'arrowUp' };      // green up arrow
      if (/\breduce\b/.test(n)) return { tone: 'fail', icon: 'arrowDown' };      // pink down arrow
      if (/\bkeep\b/.test(n)) return { tone: 'neutral', icon: 'flat' };          // flat line
      if (/\bvacant\b/.test(n)) return { tone: 'good', icon: 'house' };          // green house
      if (/squatter|occupied/.test(n)) return { tone: 'fail', icon: 'person' };  // pink person
      return { tone: null, icon: null };
    };
    return (
      <div className={compactOptions ? 'flex gap-1' : 'flex flex-wrap gap-1.5'}>
        {opts.map((opt) => {
          const selected = a.answerValue === opt;
          const { tone, icon } = meta(opt);
          const selectedCls =
            tone === 'good' ? 'bg-emerald-500 text-white border-emerald-500 shadow-sm'
            : tone === 'neutral' ? 'bg-gray-600 text-white border-gray-600 shadow-sm'
            : 'bg-brand text-white border-brand shadow-sm';
          const hover =
            tone === 'good' ? 'hover:border-emerald-400'
            : tone === 'neutral' ? 'hover:border-gray-400'
            : 'hover:border-brand/50';
          const cls = selected ? selectedCls : `bg-white text-ink border-gray-300 ${hover}`;
          return (
            <button
              type="button"
              key={opt}
              onClick={() => onUpdate({ answerValue: selected ? '' : opt })}
              className={`inline-flex items-center rounded-full border-2 transition whitespace-nowrap font-heading font-semibold ${compactOptions ? 'gap-1 text-[10px] px-2 py-1' : 'gap-1.5 text-xs px-3 py-1.5'} ${cls}`}
            >
              <PillIcon icon={icon} tone={tone} selected={selected} />
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
      <NumberField
        value={a.answerValue}
        onChange={(v) => onUpdate({ answerValue: v })}
        ariaLabel="Number answer"
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
