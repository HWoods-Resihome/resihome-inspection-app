import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { Question, AnswerInput, TemplateType } from '@/lib/types';
import type { SavedAnswer } from '@/lib/hubspot';
import { QuestionItem } from './QuestionItem';
import { CameraCapture } from './CameraCapture';
import { uploadPhoto, uploadFilesBatch } from '@/lib/photoUpload';

// Whether this browser supports the camera API. SSR-safe.
const hasMediaDevices = typeof navigator !== 'undefined'
  && !!navigator.mediaDevices?.getUserMedia;
import { useAutosave, type SaveState } from '@/lib/useAutosave';

type Props = {
  questions: Question[];
  templateType: TemplateType;
  templateLabel: string;
  inspectorName: string;
  propertyName: string;
  bedrooms: number;
  bathrooms: number;
  /** Property's square footage (from `square_footage` on the property object).
   *  Optional — shown in the header next to bed/bath if present. */
  squareFootage?: number | null;
  /** Inspection's region snapshot (used in the header subtitle). */
  inspectionRegion?: string;
  onSubmit: (answers: AnswerInput[], sectionPhotoUrls: Record<string, string[]>) => void;
  onCancel: () => void;

  // Round B additions:
  // -- The HubSpot Inspection record ID (used for autosave POSTs)
  inspectionRecordId: string;
  // -- The Inspection's external ID (used as a prefix for answer external IDs)
  inspectionExternalId: string;
  // -- PDF URL for this inspection (only present after submit; shown as a link
  //    in the sticky header so the user can view the generated report).
  pdfUrl?: string | null;
  // -- Existing saved answers from HubSpot (when re-opening an in-progress inspection)
  existingAnswers?: SavedAnswer[];
  // -- Read-only mode (for Completed inspections, until user clicks Reopen)
  readOnly?: boolean;
  // -- Called when first user edit happens (for the Scheduled -> In Progress transition)
  onFirstEdit?: () => void;
  // -- Called when user clicks Cancel Inspection (different from form Cancel/Exit)
  onCancelInspection?: () => void;
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
  bedrooms, bathrooms, squareFootage, inspectionRegion, onSubmit, onCancel,
  inspectionRecordId, inspectionExternalId, pdfUrl,
  existingAnswers, readOnly, onFirstEdit, onCancelInspection,
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
          // Bedroom 1 is the master/main; show "(Main)" suffix only for display.
          // The `location` field (which gets stored on Answer records) stays unchanged
          // so historical inspections still match correctly.
          const displaySuffix = i === 1 ? ' (Main)' : '';
          out.push({
            instanceKey: `bedroom-${i}`,
            baseSectionName: sectionName,
            displayName: `Bedroom ${i}${displaySuffix}`,
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
          const displaySuffix = i === 1 ? ' (Main)' : '';
          out.push({
            instanceKey: `bathroom-${i}`,
            baseSectionName: sectionName,
            displayName: `Bathroom ${i}${displaySuffix}`,
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

  // Helper: derive instanceKey from a saved answer's `location` field.
  // Inverse of how the form builds location during submit.
  // "Bedroom 1" -> "bedroom-1", "Bathroom 2" -> "bathroom-2", "Half Bath" -> "bathroom-half",
  // "" -> slugified base section name (for non-repeating sections).
  function locationToInstanceKey(location: string, baseSection: string): string {
    if (!location) {
      return slugify(baseSection);
    }
    const lower = location.toLowerCase().trim();
    if (lower === 'half bath') return 'bathroom-half';
    const m = lower.match(/^(bedroom|bathroom)\s+(\d+)$/);
    if (m) return `${m[1]}-${m[2]}`;
    return slugify(location);
  }

  // Initialize answer state. Keyed by `${questionIdExternal}::${instanceKey}` so each
  // repeating instance has independent state. If existingAnswers are provided, hydrate
  // from them.
  const [answers, setAnswers] = useState<Record<string, AnswerInput>>(() => {
    const init: Record<string, AnswerInput> = {};
    // Step 1: blank defaults for every section instance question
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
    // Step 2: overlay any existing saved Q&A answers from HubSpot
    if (existingAnswers && existingAnswers.length > 0) {
      for (const sa of existingAnswers) {
        if (sa.answerType !== 'qa') continue;
        const matchingInst = sectionInstances.find(
          (inst) =>
            inst.questions.some((q) => q.questionIdExternal === sa.questionIdExternal) &&
            ((sa.location && inst.location === sa.location) ||
             (!sa.location && !inst.location))
        );
        if (!matchingInst) continue;
        const key = answerKey(sa.questionIdExternal, matchingInst.instanceKey);
        const existing = init[key];
        if (!existing) continue;
        init[key] = {
          ...existing,
          answerValue: sa.answerValue || existing.answerValue,
          note: sa.note || '',
          quantity: sa.quantity,
          assignedTo: sa.assignedTo || undefined,
          photoUrls: sa.photoUrls || [],
          optionalPanelOpen: !!(sa.note || sa.quantity != null || (sa.photoUrls && sa.photoUrls.length > 0)),
        };
      }
    }
    return init;
  });

  // Map of answer key -> HubSpot Answer recordId (populated as autosave succeeds
  // OR pre-populated from existingAnswers on load).
  const answerRecordIdsRef = useRef<Map<string, string>>(new Map());

  // Section photos keyed by instanceKey (so Bedroom 1 and Bedroom 2 have separate photos)
  const [sectionPhotos, setSectionPhotos] = useState<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    if (existingAnswers) {
      for (const sa of existingAnswers) {
        if (sa.answerType !== 'section_photo') continue;
        // Use location to map to the correct instance
        const matchingInst = sectionInstances.find((inst) => {
          if (sa.location && inst.location === sa.location) return true;
          if (!sa.location && (inst.baseSectionName === sa.section || slugify(inst.baseSectionName) === slugify(sa.section))) return true;
          return false;
        });
        const key = matchingInst?.instanceKey ?? locationToInstanceKey(sa.location, sa.section);
        if (sa.photoUrls && sa.photoUrls.length > 0) {
          if (!out[key]) out[key] = [];
          out[key].push(...sa.photoUrls);
        }
      }
    }
    return out;
  });

  // Which section instance has the in-app camera open right now (null = closed).
  // Only one camera can be open at a time; this also tells us where to append
  // captured photos when the user taps Done.
  const [sectionCameraInstance, setSectionCameraInstance] = useState<string | null>(null);

  // Map of instanceKey -> HubSpot Answer recordId for section_photo records
  const sectionPhotoRecordIdsRef = useRef<Map<string, string>>(new Map());
  // Populate from existing answers
  useEffect(() => {
    if (!existingAnswers) return;
    const m = new Map<string, string>();
    const aMap = new Map<string, string>();
    for (const sa of existingAnswers) {
      if (sa.answerType === 'section_photo') {
        // best-effort instanceKey
        const matchingInst = sectionInstances.find((inst) => {
          if (sa.location && inst.location === sa.location) return true;
          if (!sa.location && (inst.baseSectionName === sa.section || slugify(inst.baseSectionName) === slugify(sa.section))) return true;
          return false;
        });
        const key = matchingInst?.instanceKey ?? locationToInstanceKey(sa.location, sa.section);
        m.set(key, sa.recordId);
      } else if (sa.answerType === 'qa') {
        const matchingInst = sectionInstances.find(
          (inst) =>
            inst.questions.some((q) => q.questionIdExternal === sa.questionIdExternal) &&
            ((sa.location && inst.location === sa.location) ||
             (!sa.location && !inst.location))
        );
        if (matchingInst) {
          aMap.set(answerKey(sa.questionIdExternal, matchingInst.instanceKey), sa.recordId);
        }
      }
    }
    sectionPhotoRecordIdsRef.current = m;
    answerRecordIdsRef.current = aMap;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize autosave
  const autosave = useAutosave({
    inspectionRecordId,
    inspectionExternalId,
    disabled: !!readOnly,
    onFirstSave: onFirstEdit,
  });

  // After mount, hydrate the autosave hook with existing data so it knows
  // each answer's recordId (for PATCH updates instead of duplicate creates).
  useEffect(() => {
    if (!existingAnswers || existingAnswers.length === 0) return;
    const initial: Array<{ key: string; answer: AnswerInput; recordId: string; questionHubspotRecordId: string; instanceKey: string }> = [];
    for (const [key, recordId] of answerRecordIdsRef.current.entries()) {
      const a = answers[key];
      if (!a) continue;
      // Find the question to get the HubSpot record ID
      const q = questions.find((x) => x.questionIdExternal === a.questionIdExternal);
      if (!q) continue;
      const [, instanceKey] = key.split('::');
      initial.push({
        key,
        answer: a,
        recordId,
        questionHubspotRecordId: q.hubspotRecordId,
        instanceKey,
      });
    }
    autosave.hydrate(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Collapsed state.
  // Scope: every section EXCEPT the first instance starts collapsed (Hayden's request for Scope).
  // Non-Scope: keep prior behavior -- everything open except repeating bedroom/bathroom instances 2..N + Half Bath.
  // Per-section collapse of the photo strip.
  const [photosCollapsed, setPhotosCollapsed] = useState<Record<string, boolean>>({});

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const c = new Set<string>();
    if ((templateType as string) === 'pm_scope_inspection') {
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
    if (readOnly) return; // No edits in read-only mode

    // Skip noop-only updates (like toggling optionalPanelOpen) -- they shouldn't trigger autosave
    const onlyPanelToggle = Object.keys(patch).length === 1 && 'optionalPanelOpen' in patch;

    // Compute the new value outside the setter so we can capture it for autosave
    let updated: AnswerInput | undefined;
    setAnswers((prev) => {
      const merged = { ...prev[key], ...patch };
      updated = merged;
      return { ...prev, [key]: merged };
    });

    if (!onlyPanelToggle && updated) {
      const [, instanceKey] = key.split('::');
      autosave.noteEdit(key, updated, updated.questionHubspotRecordId, instanceKey);
    }
  }

  // uploadPhoto comes from @/lib/photoUpload (shared with RateCardForm).
  // The shared version has retry-with-backoff for flaky cell network uploads.

  // Upload progress: tracks which section is currently uploading and the count
  const [uploadingSection, setUploadingSection] = useState<{
    instanceKey: string;
    current: number;
    total: number;
  } | null>(null);

  async function handleSectionPhotoChange(instanceKey: string, files: FileList | null) {
    if (!files || files.length === 0) return;
    const fileArr = Array.from(files);
    setUploadingSection({ instanceKey, current: 0, total: fileArr.length });
    try {
      const { failed, errors } = await uploadFilesBatch(
        fileArr,
        (url) => {
          // Append the URL to section state as soon as that one upload finishes.
          // Inspector sees thumbnails appearing one by one.
          setSectionPhotos((prev) => ({
            ...prev,
            [instanceKey]: [...(prev[instanceKey] || []), url],
          }));
        },
        (current) => setUploadingSection((prev) => prev ? { ...prev, current } : prev),
      );
      if (failed > 0) {
        // Show the first error reason so the inspector knows WHY it failed
        // (network drop, file too big, server reject) instead of a bare count.
        const reason = errors[0] ? `\n\nReason: ${errors[0]}` : '';
        alert(
          `${failed} of ${fileArr.length} photo${fileArr.length === 1 ? '' : 's'} failed to upload. ` +
          `Photos that succeeded have been saved.${reason}`
        );
      }
    } catch (e: any) {
      alert(`Photo upload failed: ${e.message || e}`);
    } finally {
      setUploadingSection(null);
    }
  }

  function removeSectionPhoto(instanceKey: string, idx: number) {
    if (readOnly) return;
    setSectionPhotos((prev) => ({
      ...prev,
      [instanceKey]: (prev[instanceKey] || []).filter((_, i) => i !== idx),
    }));
  }

  // Sync section photos to HubSpot whenever they change (debounced).
  // Each instance has a single section_photo Answer record; we upsert it when photos change.
  const sectionPhotoDirtyRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (readOnly) return;
    // Diff against the last-saved state by tracking which instances changed.
    // Simple approach: when sectionPhotos changes, mark all instances as potentially dirty.
    // Real diff happens at flush time.
    for (const instanceKey of Object.keys(sectionPhotos)) {
      sectionPhotoDirtyRef.current.add(instanceKey);
    }
  }, [sectionPhotos, readOnly]);

  useEffect(() => {
    if (readOnly) return;
    const id = setInterval(async () => {
      if (sectionPhotoDirtyRef.current.size === 0) return;
      const dirtyKeys = Array.from(sectionPhotoDirtyRef.current);
      sectionPhotoDirtyRef.current.clear();

      // Build a deterministic mapping from external ID -> instanceKey so we can
      // map responses back without fragile parsing.
      const externalIdToInstance = new Map<string, string>();
      const upserts: any[] = [];
      const archives: string[] = [];

      for (const instanceKey of dirtyKeys) {
        const urls = sectionPhotos[instanceKey] || [];
        const inst = sectionInstances.find((x) => x.instanceKey === instanceKey);
        if (!inst) continue;
        const existingRecordId = sectionPhotoRecordIdsRef.current.get(instanceKey);

        if (urls.length === 0) {
          // No photos -- archive the section_photo record if it exists
          if (existingRecordId) {
            archives.push(existingRecordId);
            sectionPhotoRecordIdsRef.current.delete(instanceKey);
          }
          continue;
        }

        const externalId = `${inspectionExternalId}_sp_${instanceKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        externalIdToInstance.set(externalId, instanceKey);

        const baseSection = inst.baseSectionName;
        const props: Record<string, any> = {
          answer_id_external: externalId,
          answer_summary: `${inst.displayName} / Section Photo (${urls.length})`,
          answer_type: 'section_photo',
          section: baseSection,
          photo_urls: urls.join(';'),
          photo_count: urls.length,
          submitted_at: new Date().toISOString(),
          inspection_id_external: inspectionExternalId,
        };
        if (inst.location) props.location = inst.location;

        upserts.push({
          recordId: existingRecordId,
          answerProps: props,
          questionHubspotRecordId: null,
        });
      }

      if (upserts.length === 0 && archives.length === 0) return;

      try {
        const r = await fetch(`/api/inspections/${inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upserts, archives, bumpStatusToInProgress: true }),
        });
        if (!r.ok) {
          console.error('Section photo save failed', await r.text());
          // re-mark dirty so we retry next tick
          for (const k of dirtyKeys) sectionPhotoDirtyRef.current.add(k);
          return;
        }
        const data = await r.json();
        // Map each response back to its instanceKey using the deterministic table
        for (const result of (data.results || [])) {
          const eid = result.answerIdExternal;
          const ikey = externalIdToInstance.get(eid);
          if (ikey) {
            sectionPhotoRecordIdsRef.current.set(ikey, result.recordId);
          }
        }
        if (!hasEverHadSectionSave.current) {
          hasEverHadSectionSave.current = true;
          onFirstEdit?.();
        }
      } catch (e) {
        console.error('Section photo save error:', e);
        for (const k of dirtyKeys) sectionPhotoDirtyRef.current.add(k);
      }
    }, 2500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, inspectionRecordId, inspectionExternalId, sectionPhotos, sectionInstances]);

  const hasEverHadSectionSave = useRef(false);

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
          if ((templateType as string) === 'pm_scope_inspection') {
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

  async function handleSubmit() {
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

    // Force a final flush of any pending autosave changes before finalizing
    if (!readOnly) {
      await autosave.flush(true);
    }

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
              {squareFootage != null && squareFootage > 0 && (
                <span> &middot; {squareFootage.toLocaleString()} sqft</span>
              )}
              {inspectionRegion && <span> &middot; {inspectionRegion}</span>}
            </div>
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs font-heading font-semibold text-brand hover:underline"
                title="Open the generated inspection report (opens in a new tab)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                View PDF Report
              </a>
            )}
          </div>
          <div className="flex items-start gap-3 ml-3 shrink-0">
            <div className="text-right">
              <div className="text-base font-heading font-bold text-brand">{totalCompleted}/{totalQuestions}</div>
              <div className="text-xs text-gray-500 uppercase tracking-wider">answered</div>
            </div>
            {/* Back button — flushes pending edits (when editable) then exits,
                same as Save & Close. Shown for every status. */}
            <button
              type="button"
              onClick={async () => {
                if (!readOnly) {
                  try {
                    await autosave.flush(true);
                  } catch (e) {
                    console.error('Back: flush failed', e);
                  }
                }
                onCancel();
              }}
              className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg px-2.5 py-1.5 bg-white"
              title="Save and go back"
            >
              <span aria-hidden>←</span> Back
            </button>
          </div>
        </div>
        {/* Save indicator strip */}
        {!readOnly && (
          <div className="max-w-3xl mx-auto px-4 pb-2">
            <SaveIndicator saveState={autosave.saveState} />
          </div>
        )}
        {readOnly && (
          <div className="max-w-3xl mx-auto px-4 pb-2">
            <div className="inline-flex items-center gap-1.5 text-xs text-gray-500 bg-gray-100 border border-gray-200 px-2 py-1 rounded-full">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Read-only (Completed)</span>
            </div>
          </div>
        )}
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
            <section key={inst.instanceKey} id={sectionDomId} className="mb-8 scroll-mt-24 rounded-xl shadow-md overflow-hidden">
              {/* Section header (tappable to collapse) */}
              <button
                type="button"
                onClick={() => toggleCollapsed(inst.instanceKey)}
                aria-expanded={!isCollapsed}
                className="w-full bg-gray-50 text-gray-900 border-b border-gray-200 px-4 py-3 flex items-center justify-between text-left hover:bg-gray-100 transition"
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
                  {photosMissing && (
                    <span
                      className="inline-flex items-center gap-1 text-xs bg-amber-400 text-amber-950 font-heading font-bold px-2 py-0.5 rounded-full shrink-0"
                      title="This section requires at least one photo"
                    >
                      📷 Photos Needed
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-3">
                  <span className="text-sm bg-brand text-white font-heading font-semibold px-2.5 py-0.5 rounded-full">
                    {prog.completed}/{prog.total}
                  </span>
                </div>
              </button>

              {!isCollapsed && (
                <div className="bg-white border-x border-b border-gray-200 divide-y divide-gray-100">
                  {/* Section photos — compact single-row layout (matches RateCardForm) */}
                  <div className={`px-3 py-2 ${photosMissing ? 'bg-amber-50' : 'bg-gray-50'}`}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <button
                          type="button"
                          onClick={() => setPhotosCollapsed((c) => ({ ...c, [inst.instanceKey]: !c[inst.instanceKey] }))}
                          className="flex items-baseline gap-1.5 min-w-0"
                        >
                          <span className={`text-gray-400 text-[10px] self-center transition-transform ${photosCollapsed[inst.instanceKey] ? '' : 'rotate-90'}`}>&#9654;</span>
                          <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide whitespace-nowrap">
                            Section Photos
                            {photosRequired
                              ? <span className="text-brand ml-1">*</span>
                              : <span className="text-gray-400 normal-case font-normal ml-1">(optional)</span>}
                          </span>
                        </button>
                        {photosMissing && uploadingSection?.instanceKey !== inst.instanceKey && (
                          <span className="text-xs text-amber-800 font-semibold">at least 1 required</span>
                        )}
                        {uploadingSection?.instanceKey === inst.instanceKey && (
                          <span className="text-xs text-brand font-semibold">
                            Uploading {uploadingSection.current} of {uploadingSection.total}...
                          </span>
                        )}
                        {sectionPhotoUrls.length > 0 && !photosMissing && uploadingSection?.instanceKey !== inst.instanceKey && (
                          <span className="text-xs text-gray-500">{sectionPhotoUrls.length} added</span>
                        )}
                      </div>
                      {!readOnly && (
                        <div className="flex gap-2 items-center">
                          <button
                            type="button"
                            onClick={() => setSectionCameraInstance(inst.instanceKey)}
                            disabled={!!uploadingSection || !hasMediaDevices}
                            className="inline-flex items-center gap-1 text-xs bg-brand text-white font-semibold py-1 px-2 rounded hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed"
                            title={hasMediaDevices ? 'In-app camera' : 'Camera not supported in this browser'}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                              <circle cx="12" cy="13" r="4" />
                            </svg>
                            Take
                          </button>
                          <label className={`inline-flex items-center gap-1 text-xs bg-brand/10 text-brand font-semibold py-1 px-2 rounded hover:bg-brand/20 ${
                            uploadingSection?.instanceKey === inst.instanceKey ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                          }`}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="17 8 12 3 7 8" />
                              <line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            Upload
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              onChange={(e) => handleSectionPhotoChange(inst.instanceKey, e.target.files)}
                              disabled={uploadingSection?.instanceKey === inst.instanceKey}
                              className="hidden"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                    {sectionPhotoUrls.length > 0 && !photosCollapsed[inst.instanceKey] && (
                      <div className="flex gap-1.5 overflow-x-auto pb-1 mt-2 -mx-0.5 px-0.5">
                        {sectionPhotoUrls.map((url, idx) => (
                          <div key={idx} className="relative shrink-0">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <a href={url} target="_blank" rel="noopener noreferrer">
                              <img src={url} alt="" className="w-16 h-16 object-cover rounded border border-gray-200" />
                            </a>
                            {!readOnly && (
                              <button
                                type="button"
                                onClick={() => removeSectionPhoto(inst.instanceKey, idx)}
                                className="absolute -top-1 -right-1 bg-ink text-white text-xs w-4 h-4 rounded-full leading-none flex items-center justify-center hover:bg-brand"
                              >&times;</button>
                            )}
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

      {/* Sticky submit bar.
          Layout: Cancel Inspection (destructive) anchored LEFT so it's
          isolated from the primary actions. Save & Close + Submit grouped
          on the right. Save & Close gets a green hover/active style for
          visual reassurance that it's saving work. Matches the same layout
          used in RateCardForm so behavior is consistent across templates. */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t-2 border-brand px-3 sm:p-4 py-2.5 shadow-lg">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-2">
          <div className="shrink-0">
            {!readOnly && onCancelInspection && (
              <button
                type="button"
                onClick={onCancelInspection}
                className="px-2.5 sm:px-3 py-2.5 sm:py-3 border border-red-300 rounded-lg hover:bg-red-50 font-heading font-semibold text-red-700 text-xs sm:text-sm whitespace-nowrap"
                title="Mark this Inspection as Cancelled in HubSpot"
              >
                Cancel
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 justify-end shrink-0">
            {!readOnly && (
              <button
                type="button"
                onClick={async () => {
                  // Force a final flush so the last 2 seconds of debounced edits get saved.
                  // Inspection remains in current status (Scheduled or In Progress).
                  try {
                    await autosave.flush(true);
                  } catch (e) {
                    // Even if save fails, we should still leave -- alert and continue
                    console.error('Save & Close: flush failed', e);
                  }
                  onCancel();
                }}
                className="px-2.5 sm:px-3 py-2.5 sm:py-3 border border-emerald-300 rounded-lg hover:bg-emerald-600 hover:text-white hover:border-emerald-600 active:bg-emerald-700 active:border-emerald-700 font-heading font-semibold text-emerald-700 text-xs sm:text-sm transition-colors whitespace-nowrap"
                title="Save any pending changes and return to the inspection list. Inspection stays In Progress."
              >
                Save &amp; Close
              </button>
            )}
            {readOnly && (
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 font-heading font-semibold text-ink text-sm whitespace-nowrap"
                title="Return to inspection list"
              >
                Close
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={handleSubmit}
                className="bg-brand hover:bg-brand-dark text-white font-heading font-bold px-3 sm:px-5 py-2.5 sm:py-3 rounded-lg active:scale-[0.99] transition text-xs sm:text-sm whitespace-nowrap"
              >
                <span className="sm:hidden">Submit</span>
                <span className="hidden sm:inline">Submit Inspection</span>
              </button>
            )}
            {readOnly && (
              <div className="text-center text-sm text-gray-500 font-heading py-3">
                This Inspection is Completed (read-only)
              </div>
            )}
          </div>
        </div>
      </div>

      {/* In-app camera overlay for section photos. Only mounted when an instance
          has the camera open; on Done, photos are appended to that instance's
          sectionPhotos list (autosave picks them up automatically). */}
      <CameraCapture
        isOpen={sectionCameraInstance !== null}
        onClose={() => setSectionCameraInstance(null)}
        uploadPhoto={uploadPhoto}
        onComplete={(urls) => {
          const ikey = sectionCameraInstance;
          setSectionCameraInstance(null);
          if (ikey && urls.length > 0) {
            setSectionPhotos((prev) => ({
              ...prev,
              [ikey]: [...(prev[ikey] || []), ...urls],
            }));
          }
        }}
      />
    </main>
  );
}

// Save indicator: small badge showing autosave status at the top of the form.
function SaveIndicator({ saveState }: { saveState: SaveState }) {
  if (saveState.kind === 'idle') {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-gray-500 font-heading">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-600">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span>All changes saved</span>
      </div>
    );
  }
  if (saveState.kind === 'dirty') {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-amber-700 font-heading font-semibold">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <span>Saving in a moment&hellip;</span>
      </div>
    );
  }
  if (saveState.kind === 'saving') {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-brand font-heading font-semibold">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
             className="animate-spin">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span>Saving&hellip;</span>
      </div>
    );
  }
  if (saveState.kind === 'saved') {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-green-700 font-heading font-semibold">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span>Saved</span>
      </div>
    );
  }
  if (saveState.kind === 'error') {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-red-700 font-heading font-semibold">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>Save failed &mdash; will retry</span>
      </div>
    );
  }
  return null;
}
