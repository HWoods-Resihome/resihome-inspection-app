import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerInput } from '@/lib/types';

/**
 * State of each answer in the autosave queue.
 */
export interface AutosaveAnswerState {
  // Live form value (parents update this)
  answer: AnswerInput;
  // HubSpot record ID if the answer has been saved at least once
  recordId: string | null;
  // The HubSpot Question record ID (constant per question)
  questionHubspotRecordId: string;
  // The instance key (e.g., "bedroom-1") -- used to build deterministic external IDs
  instanceKey: string;
  // Timestamp of the last user edit. null = clean (matches what's in HubSpot)
  dirtySince: number | null;
  // Timestamp of last successful save
  lastSavedAt: number | null;
}

/**
 * Global save state (shown to the user as one indicator).
 */
export type SaveState =
  | { kind: 'idle' }                     // no changes since last save
  | { kind: 'dirty' }                    // user typed but debounce not elapsed
  | { kind: 'saving' }                   // POST in flight
  | { kind: 'saved'; at: number }        // last save succeeded
  | { kind: 'error'; message: string };  // last save failed

interface Options {
  inspectionRecordId: string;
  inspectionExternalId: string;
  // Called whenever a save completes. Used to update parent state with new recordIds.
  onSaveSuccess?: (updatedRecordIds: Array<{ key: string; recordId: string }>) => void;
  // Called once when the FIRST save happens (for the Scheduled -> In Progress transition)
  onFirstSave?: () => void;
  // If true, all the answer machinery is disabled (read-only mode for Completed inspections)
  disabled?: boolean;
}

const DEBOUNCE_MS = 800;
const CHECK_INTERVAL_MS = 400;

export function useAutosave(opts: Options) {
  const { inspectionRecordId, inspectionExternalId, onSaveSuccess, onFirstSave, disabled } = opts;

  // Persistent reference to the latest answer states, indexed by composite key.
  // We use a ref (not state) to avoid stale closures inside the interval timer.
  const answerStatesRef = useRef<Map<string, AutosaveAnswerState>>(new Map());
  // Set of recordIds queued to be archived (e.g., when an answer was cleared)
  const archiveQueueRef = useRef<Set<string>>(new Set());

  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [hasEverSaved, setHasEverSaved] = useState(false);
  const inFlightRef = useRef(false);

  // Mark an answer as edited. The state map is updated and dirtySince timestamp set.
  const noteEdit = useCallback((key: string, answer: AnswerInput, questionHubspotRecordId: string, instanceKey: string) => {
    if (disabled) return;
    const existing = answerStatesRef.current.get(key);
    const now = Date.now();
    answerStatesRef.current.set(key, {
      answer,
      recordId: existing?.recordId ?? null,
      questionHubspotRecordId,
      instanceKey,
      dirtySince: now,
      lastSavedAt: existing?.lastSavedAt ?? null,
    });
    setSaveState({ kind: 'dirty' });
  }, [disabled]);

  // Hydrate the autosave state from existing saved answers (when loading an inspection)
  const hydrate = useCallback((
    initial: Array<{ key: string; answer: AnswerInput; recordId: string; questionHubspotRecordId: string; instanceKey: string }>
  ) => {
    const m = new Map<string, AutosaveAnswerState>();
    for (const item of initial) {
      m.set(item.key, {
        answer: item.answer,
        recordId: item.recordId,
        questionHubspotRecordId: item.questionHubspotRecordId,
        instanceKey: item.instanceKey,
        dirtySince: null,
        lastSavedAt: Date.now(),
      });
    }
    answerStatesRef.current = m;
    if (initial.length > 0) {
      setHasEverSaved(true);
    }
  }, []);

  // Build a stable, deterministic external ID for an answer.
  const buildAnswerExternalId = useCallback((questionIdExternal: string, instanceKey: string) => {
    // Replace any chars unsafe for external IDs
    const safeQ = questionIdExternal.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeI = instanceKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${inspectionExternalId}_${safeQ}__${safeI}`;
  }, [inspectionExternalId]);

  // Flush pending dirty answers. Returns the list of changes that were attempted.
  const flush = useCallback(async (forceAll: boolean = false): Promise<boolean> => {
    if (disabled) return false;
    if (inFlightRef.current) return false; // already a flush in flight

    const now = Date.now();
    const toUpsert: Array<{
      key: string;
      state: AutosaveAnswerState;
    }> = [];
    const toArchive: string[] = Array.from(archiveQueueRef.current);

    for (const [key, state] of answerStatesRef.current.entries()) {
      if (state.dirtySince == null) continue;
      const stable = forceAll || (now - state.dirtySince >= DEBOUNCE_MS);
      if (stable) {
        toUpsert.push({ key, state });
      }
    }

    if (toUpsert.length === 0 && toArchive.length === 0) {
      // Nothing to do
      // But if everything is clean and we were dirty, mark idle
      const anyDirty = Array.from(answerStatesRef.current.values()).some((s) => s.dirtySince != null);
      if (!anyDirty && saveState.kind === 'dirty') {
        setSaveState({ kind: 'idle' });
      }
      return false;
    }

    inFlightRef.current = true;
    setSaveState({ kind: 'saving' });
    console.log(`[autosave] flushing ${toUpsert.length} upserts, ${toArchive.length} archives to inspection ${inspectionRecordId}`);

    try {
      // Build the upsert payload
      const upserts = toUpsert.map(({ state }) => {
        const a = state.answer;
        const externalId = buildAnswerExternalId(a.questionIdExternal, state.instanceKey);
        const props: Record<string, any> = {
          answer_id_external: externalId,
          answer_summary: `${a.section} ${state.instanceKey} / ${a.questionText.slice(0, 80)}`,
          answer_type: 'qa',
          section: a.section,
          answer_value: a.answerValue || '',
          submitted_at: new Date().toISOString(),
          inspection_id_external: inspectionExternalId,
          question_id_external: a.questionIdExternal,
        };
        if (a.location) props.location = a.location;
        if (a.note) props.note = a.note;
        if (a.quantity != null) props.quantity = a.quantity;
        if (a.assignedTo) props.assigned_to = a.assignedTo;
        if (a.photoUrls?.length) {
          props.photo_urls = a.photoUrls.join(';');
          props.photo_count = a.photoUrls.length;
        }
        return {
          recordId: state.recordId || undefined,
          answerProps: props,
          questionHubspotRecordId: state.recordId ? undefined : state.questionHubspotRecordId,
        };
      });

      const willBumpStatus = !hasEverSaved;

      const resp = await fetch(`/api/inspections/${inspectionRecordId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upserts,
          archives: toArchive,
          bumpStatusToInProgress: willBumpStatus,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Autosave failed (${resp.status}): ${text.slice(0, 200)}`);
      }
      const data = await resp.json();
      console.log(`[autosave] saved OK: ${(data.results || []).length} records persisted`);

      // Update record IDs in our state map based on what came back
      const results: Array<{ recordId: string; answerIdExternal: string }> = data.results || [];
      const externalIdToKey = new Map<string, string>();
      for (const { key, state } of toUpsert) {
        const eid = buildAnswerExternalId(state.answer.questionIdExternal, state.instanceKey);
        externalIdToKey.set(eid, key);
      }
      const updatedKeys: Array<{ key: string; recordId: string }> = [];
      for (const r of results) {
        const matchKey = externalIdToKey.get(r.answerIdExternal);
        if (matchKey) {
          const current = answerStatesRef.current.get(matchKey);
          if (current) {
            // If this answer hasn't been edited again since the flush started, clear its dirty flag
            const stillDirty = current.dirtySince != null && current.dirtySince > now;
            answerStatesRef.current.set(matchKey, {
              ...current,
              recordId: r.recordId,
              lastSavedAt: Date.now(),
              dirtySince: stillDirty ? current.dirtySince : null,
            });
            updatedKeys.push({ key: matchKey, recordId: r.recordId });
          }
        }
      }

      // Remove archived from archive queue
      for (const a of toArchive) archiveQueueRef.current.delete(a);

      onSaveSuccess?.(updatedKeys);
      if (willBumpStatus) {
        onFirstSave?.();
        setHasEverSaved(true);
      }

      // After save: are there still dirty answers? Then mark dirty again
      const anyDirty = Array.from(answerStatesRef.current.values()).some((s) => s.dirtySince != null);
      if (anyDirty) {
        setSaveState({ kind: 'dirty' });
      } else {
        setSaveState({ kind: 'saved', at: Date.now() });
      }
      return true;
    } catch (e: any) {
      setSaveState({ kind: 'error', message: e.message || String(e) });
      console.error('Autosave error:', e);
      return false;
    } finally {
      inFlightRef.current = false;
    }
  }, [disabled, inspectionRecordId, inspectionExternalId, hasEverSaved, onSaveSuccess, onFirstSave, buildAnswerExternalId, saveState.kind]);

  // Tick: periodically check if any dirty answers have been stable long enough
  // to flush. Hold `flush` in a ref so the interval is created ONCE and isn't
  // torn down / recreated every time saveState changes (which would otherwise
  // churn the timer and risk orphaning an in-flight save).
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    if (disabled) return;
    const id = setInterval(() => {
      void flushRef.current(false);
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [disabled]);

  // Queue an Answer record for archival (when inspector clears a previously-saved field)
  const queueArchive = useCallback((recordId: string) => {
    archiveQueueRef.current.add(recordId);
    setSaveState({ kind: 'dirty' });
  }, []);

  return {
    saveState,
    noteEdit,
    hydrate,
    flush,
    queueArchive,
    /** Returns the recordId for a given key, if known */
    getRecordId: useCallback((key: string) => answerStatesRef.current.get(key)?.recordId ?? null, []),
  };
}
