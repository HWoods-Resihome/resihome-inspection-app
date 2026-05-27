import { useMemo, useState, useCallback } from 'react';
import imageCompression from 'browser-image-compression';
import type { Question, AnswerInput, TemplateType } from '@/lib/types';
import { QuestionItem } from './QuestionItem';

type Props = {
  questions: Question[];
  templateType: TemplateType;
  templateLabel: string;
  inspectorName: string;
  propertyName: string;
  bedrooms: number;
  bathrooms: number;
  onSubmit: (answers: AnswerInput[], sectionPhotoUrls: Record<string, string[]>) => void;
  onCancel: () => void;
};

// Sections that do NOT require a section photo.
function sectionPhotosExempt(sectionName: string, sectionOrder: number): boolean {
  if (sectionOrder === 10 || sectionOrder === 190 || sectionOrder === 900 || sectionOrder === 910) return true;
  const lower = sectionName.toLowerCase();
  if (lower.includes('overview')) return true;
  if (lower.includes('review') && lower.includes('sign')) return true;
  if (lower.includes('summary')) return true;
  if (lower.includes('hap')) return true;
  return false;
}

// A SectionInstance represents one renderable section in the form.
// Non-repeating sections produce exactly one instance.
// Repeating sections (bedroom/bathroom) produce N instances based on counts.
interface SectionInstance {
  // Unique key for this instance (used in state maps + DOM IDs)
  instanceKey: string;
  // The original section name from the data (e.g., "Bedroom")
  baseSectionName: string;
  // The display name shown to the user (e.g., "Bedroom 1")
  displayName: string;
  // Optional location label sent on the Answer record (e.g., "Bedroom 1")
  location?: string;
  // sectionOrder from the original questions (used for sorting + exemption)
  sectionOrder: number;
  // The questions to render in this instance (copies of the base section's questions)
  questions: Question[];
  // For repeating sections only -- the instance number (1, 2, 3...)
  instanceNumber?: number;
  // For repeating sections only -- 'bedroom' or 'bathroom'
  roomType?: string;
}

// Compose the per-question state key for an instance.
function answerKey(questionIdExternal: string, instanceKey: string): string {
  return `${questionIdExternal}::${instanceKey}`;
}

// Slugify section/instance display name for use in DOM IDs.
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function QuestionForm({
  questions, templateType, templateLabel, inspectorName, propertyName,
  bedrooms, bathrooms, onSubmit, onCancel,
}: Props) {
  // Build the list of section instances. Repeating sections expand into multiple.
  const sectionInstances: SectionInstance[] = useMemo(() => {
    // First group questions by base section
    const bySection = new Map<string, { sectionOrder: number; questions: Question[] }>();
    for (const q of questions) {
      if (!bySection.has(q.section)) {
        bySection.set(q.section, { sectionOrder: q.sectionOrder, questions: [] });
      }
      bySection.get(q.section)!.questions.push(q);
    }

    const out: SectionInstance[] = [];

    for (const [sectionName, info] of bySection.entries()) {
      // Determine if this whole section repeats. We do this section-wide:
      // if ANY question in the section has repeats_per_room_type set, the whole section repeats.
      // (Per the data model, the section's questions are either all repeating or none are.)
      const repeatType = info.questions.find((q) => !!q.repeatsPerRoomType)?.repeatsPerRoomType || '';

      if (repeatType === 'bedroom' && bedrooms > 0) {
        for (let i = 1; i <= bedrooms; i++) {
          out.push({
            instanceKey: `bedroom-${i}`,
            baseSectionName: sectionName,
            displayName: `Bedroom ${i}`,
            location: `Bedroom ${i}`,
            sectionOrder: info.sectionOrder,
            questions: info.questions,
            instanceNumber: i,
            roomType: 'bedroom',
          });
        }
      } else if (repeatType === 'bathroom' && bathrooms > 0) {
        // Bathrooms can be fractional (1.5, 2.5). We expand each whole/half into its own:
        // 2 BA -> Bathroom 1, Bathroom 2
        // 2.5 BA -> Bathroom 1, Bathroom 2, Half Bath
        const wholeBaths = Math.floor(bathrooms);
        const hasHalf = bathrooms - wholeBaths >= 0.5;
        for (let i = 1; i <= wholeBaths; i++) {
          out.push({
            instanceKey: `bathroom-${i}`,
            baseSectionName: sectionName,
            displayName: `Bathroom ${i}`,
            location: `Bathroom ${i}`,
            sectionOrder: info.sectionOrder,
            questions: info.questions,
            instanceNumber: i,
            roomType: 'bathroom',
          });
        }
        if (hasHalf) {
          out.push({
            instanceKey: 'bathroom-half',
            baseSectionName: sectionName,
            displayName: 'Half Bath',
            location: 'Half Bath',
            sectionOrder: info.sectionOrder,
            questions: info.questions,
            roomType: 'bathroom',
          });
        }
      } else if (repeatType) {
        // Some other repeat type, or count is 0. Render once, no location.
        out.push({
          instanceKey: slugify(sectionName),
          baseSectionName: sectionName,
          displayName: sectionName,
          sectionOrder: info.sectionOrder,
          questions: info.questions,
        });
      } else {
        out.push({
          instanceKey: slugify(sectionName),
          baseSectionName: sectionName,
          displayName: sectionName,
          sectionOrder: info.sectionOrder,
          questions: info.questions,
        });
      }
    }

    out.sort((a, b) => {
      // Primary sort: sectionOrder
      if (a.sectionOrder !== b.sectionOrder) return a.sectionOrder - b.sectionOrder;
      // Secondary: instance number (so Bedroom 1, 2, 3 stay in order)
      return (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0);
    });

    return out;
  }, [questions, bedrooms, bathrooms]);

  // Initialize answer state. Keyed by `${questionIdExternal}::${instanceKey}` so each
  // repeating instance has independent state.
  const [answers, setAnswers] = useState<Record<string, AnswerInput>>(() => {
    const init: Record<string, AnswerInput> = {};
    for (const inst of sectionInstances) {
      for (const q of inst.questions) {
        const key = answerKey(q.questionIdExternal, inst.instanceKey);
        init[key] = {
          questionIdExternal: q.questionIdExternal,
          questionHubspotRecordId: q.hubspotRecordId,
          questionText: q.questionText,
          section: q.section,
          location: inst.location,
          answerValue: q.defaultValue || '',
          note: '',
          quantity: null,
          photoUrls: [],
          optionalPanelOpen: false,
        };
      }
    }
    return init;
  });

  // Section photos keyed by instanceKey (so Bedroom 1 and Bedroom 2 have separate photos)
  const [sectionPhotos, setSectionPhotos] = useState<Record<string, string[]>>({});

  // Collapsed state.
  // Scope: every section EXCEPT the first instance starts collapsed (Hayden's request for Scope).
  // Non-Scope: keep prior behavior -- everything open except repeating bedroom/bathroom instances 2..N + Half Bath.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const c = new Set<string>();
    if (templateType === 'pm_scope_inspection') {
      // Collapse everything except the first instance in render order
      for (let i = 0; i < sectionInstances.length; i++) {
        if (i === 0) continue;
        c.add(sectionInstances[i].instanceKey);
      }
    } else {
      for (const inst of sectionInstances) {
        if ((inst.roomType === 'bedroom' && (inst.instanceNumber ?? 0) > 1)
           || (inst.roomType === 'bathroom' && (inst.instanceNumber ?? 0) > 1)
           || inst.instanceKey === 'bathroom-half') {
          c.add(inst.instanceKey);
        }
      }
    }
    return c;
  });

  function toggleCollapsed(instanceKey: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(instanceKey)) next.delete(instanceKey);
      else next.add(instanceKey);
      return next;
    });
  }

  function expandSection(instanceKey: string) {
    setCollapsed((prev) => {
      if (!prev.has(instanceKey)) return prev;
      const next = new Set(prev);
      next.delete(instanceKey);
      return next;
    });
  }

  function updateAnswer(key: string, patch: Partial<AnswerInput>) {
    setAnswers((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...patch },
    }));
  }

  const uploadPhoto = useCallback(async (file: File): Promise<string> => {
    const compressed = await imageCompression(file, {
      maxSizeMB: 1,
      maxWidthOrHeight: 1600,
      useWebWorker: true,
    });
    const base64 = await fileToBase64(compressed);
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        contentType: compressed.type,
        base64,
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Upload failed: ${text}`);
    }
    const data = await r.json();
    return data.url;
  }, []);

  // Upload progress: tracks which section is currently uploading and the count
  const [uploadingSection, setUploadingSection] = useState<{
    instanceKey: string;
    current: number;
    total: number;
  } | null>(null);

  /**
   * Upload multiple files in parallel with a small concurrency cap.
   * Photos are added to state progressively (as each upload completes), so the
   * inspector sees thumbnails appear in real time rather than waiting for all
   * uploads to finish.
   *
   * Concurrency=3: a balance between throughput and not overwhelming a phone
   * on LTE or hitting HubSpot's rate limit.
   */
  async function uploadFilesBatch(
    files: File[],
    onUploaded: (url: string) => void
  ): Promise<{ failed: number }> {
    const CONCURRENCY = 3;
    let next = 0;
    let completed = 0;
    let failed = 0;

    async function worker() {
      while (next < files.length) {
        const idx = next++;
        try {
          const url = await uploadPhoto(files[idx]);
          onUploaded(url);
        } catch (e: any) {
          console.error(`Photo ${idx + 1} upload failed:`, e);
          failed++;
        }
        completed++;
        // Update progress counter regardless of success/fail
        setUploadingSection((prev) =>
          prev ? { ...prev, current: completed } : prev
        );
      }
    }

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, files.length) },
      () => worker()
    );
    await Promise.all(workers);
    return { failed };
  }

  async function handleSectionPhotoChange(instanceKey: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    const fileArr = Array.from(files);
    setUploadingSection({ instanceKey, current: 0, total: fileArr.length });
    try {
      const { failed } = await uploadFilesBatch(fileArr, (url) => {
        // Append the URL to section state as soon as that one upload finishes.
        // Inspector sees thumbnails appearing one by one.
        setSectionPhotos((prev) => ({
          ...prev,
          [instanceKey]: [...(prev[instanceKey] || []), url],
        }));
      });
      if (failed > 0) {
        alert(
          `${failed} of ${fileArr.length} photo${fileArr.length === 1 ? '' : 's'} failed to upload. ` +
          `Photos that succeeded have been saved.`
        );
      }
    } catch (e: any) {
      alert(`Photo upload failed: ${e.message || e}`);
    } finally {
      setUploadingSection(null);
    }
  }

  function removeSectionPhoto(instanceKey: string, idx: number) {
    setSectionPhotos((prev) => ({
      ...prev,
      [instanceKey]: (prev[instanceKey] || []).filter((_, i) => i !== idx),
    }));
  }

  function scrollToAndFlash(domId: string, instanceKey?: string) {
    if (typeof document === 'undefined') return;
    if (instanceKey) expandSection(instanceKey);
    // Allow expansion to render before scrolling
    setTimeout(() => {
      const el = document.getElementById(domId);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash-highlight');
      setTimeout(() => el.classList.remove('flash-highlight'), 1800);
    }, 60);
  }

  // Per-instance validation. Iterates instances in order so errors surface from top.
  function validate(): { message: string; scrollToDomId: string; instanceKey: string } | null {
    for (const inst of sectionInstances) {
      // Per-question validations
      for (const q of inst.questions) {
        const key = answerKey(q.questionIdExternal, inst.instanceKey);
        const a = answers[key];
        const locTag = inst.location ? `${inst.location} -> ` : `${inst.displayName} -> `;
        if (q.isRequired && (!a || !a.answerValue)) {
          return {
            message: `Required: ${locTag}${q.questionText}`,
            scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
            instanceKey: inst.instanceKey,
          };
        }
        if (a && a.answerValue && q.noteRequiredOnValues.length > 0 && q.noteRequiredOnValues.includes(a.answerValue)) {
          if (!a.note?.trim()) {
            return {
              message: `Note required: ${locTag}${q.questionText} (selected "${a.answerValue}")`,
              scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
              instanceKey: inst.instanceKey,
            };
          }
          if (templateType === 'pm_scope_inspection') {
            if (a.quantity == null || Number.isNaN(a.quantity)) {
              return {
                message: `Quantity required: ${locTag}${q.questionText} (Scope)`,
                scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
                instanceKey: inst.instanceKey,
              };
            }
          }
          // Assigned To validation: only if the question supports it.
          // useEffect in QuestionItem auto-defaults to "Vendor 1", so this is a backstop.
          if (q.hasAssignedTo && !a.assignedTo?.trim()) {
            return {
              message: `Assigned To required: ${locTag}${q.questionText}`,
              scrollToDomId: `q-${inst.instanceKey}-${q.questionIdExternal}`,
              instanceKey: inst.instanceKey,
            };
          }
        }
      }
      // Section photo validation (per-instance)
      if (!sectionPhotosExempt(inst.baseSectionName, inst.sectionOrder)) {
        const photos = sectionPhotos[inst.instanceKey] || [];
        if (photos.length === 0) {
          return {
            message: `Section photo required: ${inst.displayName}`,
            scrollToDomId: `section-${inst.instanceKey}`,
            instanceKey: inst.instanceKey,
          };
        }
      }
    }
    return null;
  }

  function handleSubmit() {
    const err = validate();
    if (err) {
      alert(err.message);
      scrollToAndFlash(err.scrollToDomId, err.instanceKey);
      return;
    }
    const totalSectionPhotos = Object.values(sectionPhotos).flat().length;
    const totalQuestionPhotos = Object.values(answers).reduce((acc, a) => acc + a.photoUrls.length, 0);
    const ok = confirm(
      `Submit ${Object.keys(answers).length} answers, ` +
      `${totalQuestionPhotos} question photos, ` +
      `${totalSectionPhotos} section photos to HubSpot?`
    );
    if (!ok) return;

    // For non-Scope: ensure triggered answers get quantity=1 if not set
    const finalAnswers = Object.values(answers).map((a) => {
      const q = questions.find((x) => x.questionIdExternal === a.questionIdExternal);
      const isTriggered = !!q && !!a.answerValue && q.noteRequiredOnValues.includes(a.answerValue);
      let finalQuantity = a.quantity;
      if (isTriggered && (finalQuantity == null || Number.isNaN(finalQuantity))) {
        finalQuantity = 1;
      }
      return { ...a, quantity: finalQuantity };
    });

    // Build sectionPhotoUrls keyed by display name (with location). The submit
    // API maps these to section_photo Answer records that include location.
    const sectionPhotoUrlsForApi: Record<string, string[]> = {};
    for (const inst of sectionInstances) {
      const urls = sectionPhotos[inst.instanceKey] || [];
      if (urls.length === 0) continue;
      // Use the instance display name as the key (e.g., "Bedroom 1") so PDFs and
      // Answer records preserve the location.
      sectionPhotoUrlsForApi[inst.displayName] = urls;
    }

    onSubmit(finalAnswers, sectionPhotoUrlsForApi);
  }

  // Completion progress per instance
  const sectionProgress = useMemo(() => {
    const out: Record<string, { completed: number; total: number }> = {};
    for (const inst of sectionInstances) {
      let completed = 0;
      for (const q of inst.questions) {
        const key = answerKey(q.questionIdExternal, inst.instanceKey);
        const a = answers[key];
        if (a && a.answerValue) completed++;
      }
      out[inst.instanceKey] = { completed, total: inst.questions.length };
    }
    return out;
  }, [sectionInstances, answers]);

  const totalCompleted = Object.values(sectionProgress).reduce((acc, s) => acc + s.completed, 0);
  const totalQuestions = Object.values(sectionProgress).reduce((acc, s) => acc + s.total, 0);

  return (
    <main className="min-h-screen bg-white">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 bg-white border-b-2 border-brand shadow-sm">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-heading font-semibold text-ink truncate">{propertyName}</div>
            <div className="text-xs text-gray-500 truncate">
              {templateLabel} &middot; {inspectorName} &middot; {bedrooms}BR / {bathrooms}BA
            </div>
          </div>
          <div className="text-right ml-3 shrink-0">
            <div className="text-base font-heading font-bold text-brand">{totalCompleted}/{totalQuestions}</div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">answered</div>
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-6 pb-32">
        {sectionInstances.map((inst) => {
          const prog = sectionProgress[inst.instanceKey];
          const sectionPhotoUrls = sectionPhotos[inst.instanceKey] || [];
          const photosRequired = !sectionPhotosExempt(inst.baseSectionName, inst.sectionOrder);
          const photosMissing = photosRequired && sectionPhotoUrls.length === 0;
          const isCollapsed = collapsed.has(inst.instanceKey);
          const sectionDomId = `section-${inst.instanceKey}`;

          return (
            <section key={inst.instanceKey} id={sectionDomId} className="mb-8 scroll-mt-24">
              {/* Section header (tappable to collapse) */}
              <button
                type="button"
                onClick={() => toggleCollapsed(inst.instanceKey)}
                aria-expanded={!isCollapsed}
                className={`w-full bg-ink text-white ${isCollapsed ? 'rounded-xl' : 'rounded-t-xl'} px-4 py-3 flex items-center justify-between text-left hover:bg-gray-900 transition`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    className={`shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <h2 className="font-heading font-bold text-lg truncate">{inst.displayName}</h2>
                  {photosMissing && !isCollapsed && (
                    <span className="text-xs text-amber-300 italic shrink-0">photo needed</span>
                  )}
                </div>
                <span className="text-sm bg-brand text-white font-heading font-semibold px-2.5 py-0.5 rounded-full shrink-0 ml-3">
                  {prog.completed}/{prog.total}
                </span>
              </button>

              {!isCollapsed && (
                <div className="bg-white border border-t-0 border-gray-200 rounded-b-xl divide-y divide-gray-100">
                  {/* Section photos */}
                  <div className={`p-4 ${photosMissing ? 'bg-amber-50' : 'bg-gray-50'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs font-heading font-semibold text-ink uppercase tracking-wider">
                        Section Photos
                        {photosRequired ? (
                          <span className="text-brand ml-1">*</span>
                        ) : (
                          <span className="text-gray-400 normal-case tracking-normal font-normal ml-1">(optional)</span>
                        )}
                      </div>
                      {sectionPhotoUrls.length > 0 && (
                        <span className="text-xs text-gray-500 font-heading">
                          {sectionPhotoUrls.length} added
                        </span>
                      )}
                    </div>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) => handleSectionPhotoChange(inst.instanceKey, e.target.files)}
                      className="text-sm block w-full file:mr-2 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-heading file:font-semibold file:bg-brand/10 file:text-brand hover:file:bg-brand/20 cursor-pointer"
                      disabled={uploadingSection?.instanceKey === inst.instanceKey}
                    />
                    {uploadingSection?.instanceKey === inst.instanceKey && (
                      <div className="text-xs text-brand mt-2 font-heading font-semibold">
                        Uploading {uploadingSection.current} of {uploadingSection.total}...
                      </div>
                    )}
                    {photosMissing && (
                      <div className="text-xs text-amber-800 mt-2 font-heading font-semibold">
                        At least 1 photo is required for this section.
                      </div>
                    )}
                    {sectionPhotoUrls.length > 0 && (
                      <div className="grid grid-cols-3 gap-2 mt-3">
                        {sectionPhotoUrls.map((url, idx) => (
                          <div key={idx} className="relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt="" className="w-full h-20 object-cover rounded" />
                            <button
                              type="button"
                              onClick={() => removeSectionPhoto(inst.instanceKey, idx)}
                              className="absolute -top-1 -right-1 bg-ink text-white text-xs w-5 h-5 rounded-full leading-none flex items-center justify-center hover:bg-brand transition"
                            >&times;</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Questions for this instance */}
                  {inst.questions.map((q) => {
                    const key = answerKey(q.questionIdExternal, inst.instanceKey);
                    return (
                      <div key={key} id={`q-${inst.instanceKey}-${q.questionIdExternal}`} className="scroll-mt-24">
                        <QuestionItem
                          question={q}
                          answer={answers[key]}
                          templateType={templateType}
                          onUpdate={(patch) => updateAnswer(key, patch)}
                          uploadPhoto={uploadPhoto}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* Sticky submit bar */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t-2 border-brand p-4 shadow-lg">
        <div className="max-w-3xl mx-auto flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 font-heading font-semibold text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="flex-1 bg-brand hover:bg-brand-dark text-white font-heading font-bold py-3 rounded-lg active:scale-[0.99] transition"
          >
            Submit Inspection
          </button>
        </div>
      </div>
    </main>
  );
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
