/**
 * useRateCardAutosave — handles debounced persistence of rate card lines and
 * per-section photos to HubSpot.
 *
 * Why a hook: the RateCardForm component is already large. Extracting all the
 * timer + dirty-set + flush bookkeeping here keeps that file focused on UI.
 *
 * The hook owns:
 *   - Tracking which lines / photos are dirty
 *   - The 2-second debounce timer
 *   - Race-condition-safe save calls (cancels stale saves when state changes)
 *   - The visible save status (idle / saving / saved / error)
 *
 * The host component owns:
 *   - The actual line + photo state (linesBySection, photosBySection)
 *   - The recordId map (externalId → HubSpot record id), updated on save
 *
 * Usage:
 *   const autosave = useRateCardAutosave({
 *     inspectionRecordId,
 *     linesBySection,
 *     photosBySection,
 *     ...
 *   });
 *
 *   // After mutating state, mark dirty:
 *   autosave.markLineDirty(externalId);
 *   autosave.markPhotosDirty(sectionId);
 *
 *   // On line deletion:
 *   autosave.markLineDeleted(externalId, recordId);   // recordId optional if never saved
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RateCardLineInput } from '@/lib/types';
import { buildSectionPhotoAnswerProps } from '@/lib/answerProps';

const DEBOUNCE_MS = 2000;
const SAVED_FLASH_MS = 2000;     // how long "Saved" stays visible after a successful save

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface Args {
  inspectionRecordId: string;
  inspectionExternalId: string;
  linesBySection: Record<string, RateCardLineInput[]>;
  photosBySection: Record<string, string[]>;
  // Maps externalId → HubSpot inspection_answer record id for upserts.
  // We update this map after each successful save.
  recordIdsByExternalId: Record<string, string>;
  setRecordIdsByExternalId: (m: Record<string, string>) => void;
  // Section photo record ids — one per section. Same upsert pattern.
  sectionPhotoRecordIds: Record<string, string>;
  setSectionPhotoRecordIds: (m: Record<string, string>) => void;
  // Section-key lookup: when saving a photo answer we need the section label
  // + location to write onto the answer record.
  resolveSection: (sectionId: string) => { label: string; location: string } | null;
  // Disable autosave (e.g., when inspection is read-only / cancelled / submitted).
  enabled: boolean;
}

export interface AutosaveHandle {
  status: SaveStatus;
  errorMessage: string | null;
  // Caller methods to mark things dirty
  markLineDirty: (externalId: string) => void;
  markLineDeleted: (externalId: string, recordId?: string) => void;
  markPhotosDirty: (sectionId: string) => void;
  // Force a flush right now (e.g., before submit). Returns once complete or
  // throws on failure.
  flush: () => Promise<void>;
}

export function useRateCardAutosave(args: Args): AutosaveHandle {
  const {
    inspectionRecordId, linesBySection, photosBySection,
    recordIdsByExternalId, setRecordIdsByExternalId,
    sectionPhotoRecordIds, setSectionPhotoRecordIds,
    resolveSection, enabled,
  } = args;

  const [status, setStatus] = useState<SaveStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Dirty sets — refs so they don't trigger re-renders
  const dirtyLinesRef = useRef<Set<string>>(new Set());
  const dirtyPhotoSectionsRef = useRef<Set<string>>(new Set());
  // recordId → archive on next save (for lines deleted while having a saved id)
  const pendingArchivesRef = useRef<string[]>([]);

  // Debounce timer
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest state refs so the timer callback always reads the current state
  const linesRef = useRef(linesBySection);
  const photosRef = useRef(photosBySection);
  const recordIdsRef = useRef(recordIdsByExternalId);
  const sectionPhotoIdsRef = useRef(sectionPhotoRecordIds);
  useEffect(() => { linesRef.current = linesBySection; }, [linesBySection]);
  useEffect(() => { photosRef.current = photosBySection; }, [photosBySection]);
  useEffect(() => { recordIdsRef.current = recordIdsByExternalId; }, [recordIdsByExternalId]);
  useEffect(() => { sectionPhotoIdsRef.current = sectionPhotoRecordIds; }, [sectionPhotoRecordIds]);

  // Token for cancelling stale saves
  const saveGenerationRef = useRef(0);

  // Flag flip to clear "Saved" status after a delay
  const savedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ----- The actual save -----
  const doSave = useCallback(async (): Promise<void> => {
    if (!enabled) {
      return;
    }
    const lines = linesRef.current;
    const photos = photosRef.current;
    const dirtyLines = Array.from(dirtyLinesRef.current);
    const dirtyPhotos = Array.from(dirtyPhotoSectionsRef.current);
    const archives = pendingArchivesRef.current.slice();

    if (dirtyLines.length === 0 && dirtyPhotos.length === 0 && archives.length === 0) {
      return;
    }

    // Snapshot what we're about to send so we can clear the dirty flags on success
    dirtyLinesRef.current.clear();
    dirtyPhotoSectionsRef.current.clear();
    pendingArchivesRef.current = [];

    const myGen = ++saveGenerationRef.current;
    setStatus('saving');
    setErrorMessage(null);

    // Build line upserts: include recordId if we have one (update vs create)
    const allLines: RateCardLineInput[] = [];
    for (const arr of Object.values(lines)) allLines.push(...arr);
    type UpsertItem = { recordId: string | undefined; line: RateCardLineInput };
    const upserts = dirtyLines
      .map((externalId): UpsertItem | null => {
        const line = allLines.find((l) => l.externalId === externalId);
        if (!line) return null;
        const recordId = recordIdsRef.current[externalId];
        return { recordId, line };
      })
      .filter((u): u is UpsertItem => u !== null);

    try {
      // Save lines (if any)
      if (upserts.length > 0 || archives.length > 0) {
        const r = await fetch(`/api/inspections/${inspectionRecordId}/rate-card-lines`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upserts,
            archives,
            bumpStatusToInProgress: true,
          }),
        });
        if (!r.ok) {
          const text = await r.text();
          throw new Error(`Save failed (${r.status}): ${text.slice(0, 200)}`);
        }
        const data = await r.json();
        // Stitch back new record IDs for newly created lines
        const updates = { ...recordIdsRef.current };
        for (const result of data.results || []) {
          if (result.recordId && result.answerIdExternal) {
            updates[result.answerIdExternal] = result.recordId;
          }
        }
        if (myGen === saveGenerationRef.current) {
          setRecordIdsByExternalId(updates);
        }
      }

      // Save section photos (if any) — uses the generic /answers endpoint
      // since section photos are stored as inspection_answer records with
      // answer_type='section_photo', same as the Scope template.
      for (const sectionId of dirtyPhotos) {
        const urls = photos[sectionId] || [];
        const section = resolveSection(sectionId);
        const existingRecordId = sectionPhotoIdsRef.current[sectionId];
        const externalId = `SECTIONPHOTO-${inspectionRecordId}-${sectionId}`;

        // If no photos and no existing record, skip.
        // If no photos and a record exists, archive it.
        if (urls.length === 0) {
          if (existingRecordId) {
            await fetch(`/api/inspections/${inspectionRecordId}/answers`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                upserts: [],
                archives: [existingRecordId],
              }),
            });
            if (myGen === saveGenerationRef.current) {
              const next = { ...sectionPhotoIdsRef.current };
              delete next[sectionId];
              setSectionPhotoRecordIds(next);
            }
          }
          continue;
        }

        // Upsert the section_photo record
        const props = buildSectionPhotoAnswerProps({
          answerIdExternal: externalId,
          inspectionIdExternal: args.inspectionExternalId,
          section: section?.label || '',
          summaryLabel: section?.label || sectionId,
          location: section?.location || '',
          photoUrls: urls,
        });
        const r = await fetch(`/api/inspections/${inspectionRecordId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upserts: [{
              recordId: existingRecordId,
              answerProps: props,
              questionHubspotRecordId: null,
            }],
            archives: [],
          }),
        });
        if (!r.ok) {
          const text = await r.text();
          throw new Error(`Photo save failed (${r.status}): ${text.slice(0, 200)}`);
        }
        const data = await r.json();
        const newRecordId = data.results?.[0]?.recordId;
        if (newRecordId && myGen === saveGenerationRef.current) {
          setSectionPhotoRecordIds({
            ...sectionPhotoIdsRef.current,
            [sectionId]: newRecordId,
          });
        }
      }

      // If a newer save started while we were running, don't overwrite its status.
      if (myGen !== saveGenerationRef.current) return;
      setStatus('saved');
      // Auto-clear "Saved" after a delay
      if (savedClearTimerRef.current) clearTimeout(savedClearTimerRef.current);
      savedClearTimerRef.current = setTimeout(() => {
        // Only clear if no newer save has started since
        if (saveGenerationRef.current === myGen) setStatus('idle');
      }, SAVED_FLASH_MS);
    } catch (e: any) {
      console.error('[useRateCardAutosave] save failed:', e);
      // Re-add to dirty sets so the next save retries
      dirtyLines.forEach((id) => dirtyLinesRef.current.add(id));
      dirtyPhotos.forEach((id) => dirtyPhotoSectionsRef.current.add(id));
      pendingArchivesRef.current.unshift(...archives);
      if (myGen !== saveGenerationRef.current) return;
      setStatus('error');
      setErrorMessage(String(e?.message || e));
    }
  }, [enabled, inspectionRecordId, setRecordIdsByExternalId, setSectionPhotoRecordIds, resolveSection]);

  // Schedule a debounced save whenever something is marked dirty.
  // We use a ref-based "scheduler" so we don't need to thread the dirty state
  // through useEffect (which would fight the timer reset logic).
  const scheduleSave = useCallback(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      doSave();
    }, DEBOUNCE_MS);
  }, [doSave, enabled]);

  // Public mutators
  const markLineDirty = useCallback((externalId: string) => {
    dirtyLinesRef.current.add(externalId);
    scheduleSave();
  }, [scheduleSave]);

  const markLineDeleted = useCallback((externalId: string, recordId?: string) => {
    // Remove from dirty list (no point updating something we're deleting)
    dirtyLinesRef.current.delete(externalId);
    if (recordId) {
      pendingArchivesRef.current.push(recordId);
    }
    scheduleSave();
  }, [scheduleSave]);

  const markPhotosDirty = useCallback((sectionId: string) => {
    dirtyPhotoSectionsRef.current.add(sectionId);
    scheduleSave();
  }, [scheduleSave]);

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await doSave();
  }, [doSave]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (savedClearTimerRef.current) clearTimeout(savedClearTimerRef.current);
    };
  }, []);

  // Warn before leaving (tab close / browser back / refresh) if there are
  // un-saved edits still sitting in the debounce window. Async saves can't be
  // awaited in beforeunload, so the most reliable protection is the native
  // "Leave site?" prompt — it gives the 2s debounce time to flush, or lets the
  // user cancel. The in-app Back / Save & Close buttons flush explicitly, so
  // this only fires on hard navigation.
  useEffect(() => {
    function hasPendingEdits() {
      return (
        dirtyLinesRef.current.size > 0 ||
        dirtyPhotoSectionsRef.current.size > 0 ||
        pendingArchivesRef.current.length > 0
      );
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!enabled) return;
      // Best-effort: kick off a save (may not finish, but often does on slow nav)
      if (hasPendingEdits()) {
        void doSave();
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [enabled, doSave]);

  return { status, errorMessage, markLineDirty, markLineDeleted, markPhotosDirty, flush };
}
