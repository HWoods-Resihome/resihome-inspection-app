import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerInput } from '@/lib/types';
import { buildQaAnswerProps } from '@/lib/answerProps';
import { enqueueAnswers, clearAnswersEntry } from '@/lib/offlineOutbox';

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
  | { kind: 'offline' }                  // no connection — waiting to reconnect
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
  // Scope-only properties (quantity, assigned_to) are written to HubSpot only
  // when this is true. Non-Scope templates (1099, Community, Vacancy, RRQC)
  // must not write them — see QuestionForm submit path and
  // scripts/fix_quantity_field.
  isScope?: boolean;
}

const DEBOUNCE_MS = 800;
const CHECK_INTERVAL_MS = 400;
// After a failed save, wait before retrying so the indicator doesn't flicker
// saving→error→saving every tick. Backoff grows with consecutive failures.
const ERROR_BACKOFF_BASE_MS = 3000;
const ERROR_BACKOFF_MAX_MS = 30000;

export function useAutosave(opts: Options) {
  const { inspectionRecordId, inspectionExternalId, onSaveSuccess, onFirstSave, disabled, isScope } = opts;

  // Persistent reference to the latest answer states, indexed by composite key.
  // We use a ref (not state) to avoid stale closures inside the interval timer.
  const answerStatesRef = useRef<Map<string, AutosaveAnswerState>>(new Map());
  // Set of recordIds queued to be archived (e.g., when an answer was cleared)
  const archiveQueueRef = useRef<Set<string>>(new Set());

  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [hasEverSaved, setHasEverSaved] = useState(false);
  const inFlightRef = useRef(false);
  // Retry backoff after failures so we don't hammer the network (esp. offline).
  const consecutiveErrorsRef = useRef(0);
  const errorBackoffUntilRef = useRef(0);
  // Per-answer count of flushes where the server did NOT echo the answer back in
  // `results` (neither a success nor a reported failure). After a few we GIVE UP
  // re-saving it, so a mismatch can't pin the form on "Saving…" forever.
  const unconfirmedRef = useRef<Map<string, number>>(new Map());
  // Audit: log ONE "edited" event per editing session — on the first successful
  // save after opening the inspection, and again after the app is re-entered
  // (backgrounded long enough then reopened). Not every keystroke. Reset on
  // re-entry below so a fresh session is recorded.
  const editAuditLoggedRef = useRef(false);
  const logEditOnce = useCallback(() => {
    if (editAuditLoggedRef.current || disabled) return;
    editAuditLoggedRef.current = true;
    try {
      void fetch(`/api/inspections/${inspectionRecordId}/audit-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => { /* best-effort — never blocks editing */ });
    } catch { /* ignore */ }
  }, [disabled, inspectionRecordId]);

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

  // Build the answers-API upsert payload for one answer state. Shared by the
  // normal flush and the sendBeacon fallback so the two can never drift.
  const buildUpsertFromState = useCallback((state: AutosaveAnswerState) => {
    const a = state.answer;
    const externalId = buildAnswerExternalId(a.questionIdExternal, state.instanceKey);
    const props = buildQaAnswerProps({
      answerIdExternal: externalId,
      inspectionIdExternal: inspectionExternalId,
      questionIdExternal: a.questionIdExternal,
      questionText: a.questionText,
      section: a.section,
      summaryInstanceLabel: state.instanceKey,
      answerValue: a.answerValue || '',
      location: a.location,
      note: a.note,
      quantity: a.quantity,
      assignedTo: a.assignedTo,
      photoUrls: a.photoUrls,
      recommendedAmount: a.recommendedAmount,
    }, { isScope: !!isScope });
    return {
      recordId: state.recordId || undefined,
      answerProps: props,
      questionHubspotRecordId: state.recordId ? undefined : state.questionHubspotRecordId,
    };
  }, [buildAnswerExternalId, inspectionExternalId, isScope]);

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

    // Offline: don't repeatedly fire the network (which would flicker the
    // indicator every tick). Durably STASH the full unsaved set to the offline
    // outbox first, so answers entered in a dead zone survive closing the app
    // (they replay idempotently when service returns) — then show a steady
    // "offline" state and wait for the `online` event to retry.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      try {
        const dirty = Array.from(answerStatesRef.current.values()).filter((s) => s.dirtySince != null);
        if (dirty.length > 0 || toArchive.length > 0) {
          enqueueAnswers(inspectionRecordId, `/api/inspections/${inspectionRecordId}/answers`, {
            upserts: dirty.map((state) => buildUpsertFromState(state)),
            archives: toArchive,
            bumpStatusToInProgress: !hasEverSaved,
          });
        }
      } catch { /* best-effort durability — in-memory retry still covers the open session */ }
      setSaveState((s) => (s.kind === 'offline' ? s : { kind: 'offline' }));
      return false;
    }

    // Error backoff: after a failed save, hold off retrying until the backoff
    // window elapses so the user doesn't see it firing constantly.
    if (!forceAll && now < errorBackoffUntilRef.current) {
      return false;
    }

    inFlightRef.current = true;
    setSaveState({ kind: 'saving' });
    console.log(`[autosave] flushing ${toUpsert.length} upserts, ${toArchive.length} archives to inspection ${inspectionRecordId}`);

    try {
      // Build the upsert payload (shared builder — see buildUpsertFromState).
      const upserts = toUpsert.map(({ state }) => buildUpsertFromState(state));

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
      const results: Array<{ recordId: string; answerIdExternal: string; failed?: boolean; reason?: string }> = data.results || [];
      const externalIdToKey = new Map<string, string>();
      for (const { key, state } of toUpsert) {
        const eid = buildAnswerExternalId(state.answer.questionIdExternal, state.instanceKey);
        externalIdToKey.set(eid, key);
      }
      const updatedKeys: Array<{ key: string; recordId: string }> = [];
      let rejectedReason: string | null = null;
      for (const r of results) {
        const matchKey = externalIdToKey.get(r.answerIdExternal);
        if (!matchKey) continue;
        const current = answerStatesRef.current.get(matchKey);
        if (!current) continue;
        // If this answer hasn't been edited again since the flush started, clear its dirty flag
        const stillDirty = current.dirtySince != null && current.dirtySince > now;
        if (r.failed) {
          // HubSpot REJECTED this answer (e.g. a bad/read-only property value).
          // Clear its dirty flag so we STOP re-saving it every tick — the
          // perpetual "Saving…" loop — and surface the reason instead of hiding
          // it. Keep the existing recordId (don't blank it on a failed write).
          rejectedReason = r.reason || rejectedReason || 'A field was rejected by the server.';
          console.error(`[autosave] server rejected ${matchKey}: ${r.reason || 'unknown'}`);
          answerStatesRef.current.set(matchKey, {
            ...current,
            dirtySince: stillDirty ? current.dirtySince : null,
          });
        } else {
          answerStatesRef.current.set(matchKey, {
            ...current,
            recordId: r.recordId,
            lastSavedAt: Date.now(),
            dirtySince: stillDirty ? current.dirtySince : null,
          });
          updatedKeys.push({ key: matchKey, recordId: r.recordId });
        }
      }

      // Backstop for the OTHER loop cause: an answer the server neither confirmed
      // nor reported as failed (e.g. its answer_id_external didn't come back in
      // the response). Such an answer stays dirty and re-saves every tick. Count
      // consecutive unconfirmed flushes and give up after a few so it can't pin
      // the form on "Saving…" — the save very likely DID land (we just couldn't
      // match it); continuing forever is worse than trusting it.
      const returnedEids = new Set(results.map((r) => r.answerIdExternal).filter(Boolean));
      for (const { key, state } of toUpsert) {
        const eid = buildAnswerExternalId(state.answer.questionIdExternal, state.instanceKey);
        if (returnedEids.has(eid)) { unconfirmedRef.current.delete(key); continue; }
        const n = (unconfirmedRef.current.get(key) || 0) + 1;
        unconfirmedRef.current.set(key, n);
        if (n >= 3) {
          const current = answerStatesRef.current.get(key);
          const stillDirty = current?.dirtySince != null && current.dirtySince > now;
          if (current && !stillDirty) {
            answerStatesRef.current.set(key, { ...current, dirtySince: null });
            unconfirmedRef.current.delete(key);
            console.error(`[autosave] giving up on ${key} after ${n} unconfirmed saves (server didn't echo it back)`);
          }
        }
      }

      // Remove archived from archive queue
      for (const a of toArchive) archiveQueueRef.current.delete(a);

      // Success — clear any retry backoff, and drop the durable offline stash
      // (these answers are now persisted server-side, so it mustn't double-replay).
      consecutiveErrorsRef.current = 0;
      errorBackoffUntilRef.current = 0;
      try { clearAnswersEntry(inspectionRecordId); } catch { /* non-fatal */ }

      onSaveSuccess?.(updatedKeys);
      // First successful save of this session → record an "edited" audit event.
      logEditOnce();
      if (willBumpStatus) {
        onFirstSave?.();
        setHasEverSaved(true);
      }

      // After save: are there still dirty answers? Then mark dirty again
      const anyDirty = Array.from(answerStatesRef.current.values()).some((s) => s.dirtySince != null);
      if (anyDirty) {
        setSaveState({ kind: 'dirty' });
      } else if (rejectedReason) {
        // Everything else saved, but HubSpot rejected at least one field. Show a
        // clear error (with the reason) instead of a false "Saved" — and we are
        // no longer looping on it because its dirty flag was cleared above.
        setSaveState({ kind: 'error', message: `Some answers couldn’t be saved: ${rejectedReason}` });
      } else {
        setSaveState({ kind: 'saved', at: Date.now() });
      }
      return true;
    } catch (e: any) {
      // Schedule a backoff so the next ticks don't immediately retry and flicker
      // the indicator. Grows with consecutive failures (capped).
      consecutiveErrorsRef.current += 1;
      const backoff = Math.min(
        ERROR_BACKOFF_MAX_MS,
        ERROR_BACKOFF_BASE_MS * 2 ** (consecutiveErrorsRef.current - 1),
      );
      errorBackoffUntilRef.current = Date.now() + backoff;
      // If the failure is because we're offline, show the calmer "offline"
      // state instead of a scary "save failed".
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setSaveState({ kind: 'offline' });
      } else {
        setSaveState({ kind: 'error', message: e.message || String(e) });
      }
      console.error('Autosave error:', e);
      return false;
    } finally {
      inFlightRef.current = false;
    }
  }, [disabled, inspectionRecordId, inspectionExternalId, hasEverSaved, onSaveSuccess, onFirstSave, buildAnswerExternalId, buildUpsertFromState, saveState.kind, isScope, logEditOnce]);

  // Last-resort save when the page is genuinely being torn down (hard nav, tab
  // close, mobile pagehide). An async fetch can't finish during unload, so POST
  // the pending edits via navigator.sendBeacon — fire-and-forget, but the
  // browser delivers it after the page is gone. Auth cookies ride along
  // automatically; we send the SAME body shape as flush().
  const beaconFlush = useCallback((): boolean => {
    if (disabled || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
    const toArchive = Array.from(archiveQueueRef.current);
    const dirty = Array.from(answerStatesRef.current.values()).filter((s) => s.dirtySince != null);
    if (dirty.length === 0 && toArchive.length === 0) return false;
    try {
      const upserts = dirty.map((state) => buildUpsertFromState(state));
      const body = new Blob(
        [JSON.stringify({ upserts, archives: toArchive, bumpStatusToInProgress: !hasEverSaved })],
        { type: 'application/json' },
      );
      return navigator.sendBeacon(`/api/inspections/${inspectionRecordId}/answers`, body);
    } catch {
      return false;
    }
  }, [disabled, inspectionRecordId, hasEverSaved, buildUpsertFromState]);
  const beaconFlushRef = useRef(beaconFlush);
  beaconFlushRef.current = beaconFlush;

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
    return () => {
      clearInterval(id);
      // Flush any still-pending edits on unmount (route change, remount) so a
      // value typed within the debounce window isn't lost on navigation.
      void flushRef.current(true);
    };
  }, [disabled]);

  // When connectivity returns, clear the backoff and retry right away so the
  // queued edits save promptly (rather than waiting out the backoff window).
  useEffect(() => {
    if (disabled) return;
    const onOnline = () => {
      consecutiveErrorsRef.current = 0;
      errorBackoffUntilRef.current = 0;
      void flushRef.current(false);
    };
    window.addEventListener('online', onOnline);
    return () => { window.removeEventListener('online', onOnline); };
  }, [disabled]);

  // Best-effort flush when the tab is hidden/closed (mobile app-switch, refresh).
  // Two cases with different mechanisms:
  //   • visibilitychange→hidden: the page is NOT torn down (app switch), so the
  //     async flush has time to complete and update local state — use it.
  //   • pagehide / beforeunload: the page IS being torn down; an async fetch
  //     won't finish, so use navigator.sendBeacon (guaranteed delivery).
  useEffect(() => {
    if (disabled) return;
    let hiddenAt = 0;
    const onHidden = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); void flushRef.current(true); return; }
      // Became visible again: if we were away a while, treat the next edit as a
      // NEW session for the audit trail (re-arm the once-per-session edit log).
      if (hiddenAt && Date.now() - hiddenAt > 60_000) editAuditLoggedRef.current = false;
    };
    const onTeardown = () => { beaconFlushRef.current(); };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onTeardown);
    window.addEventListener('beforeunload', onTeardown);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onTeardown);
      window.removeEventListener('beforeunload', onTeardown);
    };
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
