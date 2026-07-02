/**
 * QcReinspectForm — the (PM) Turn Re-Inspect QC inspection form.
 *
 * Validates that a vendor completed the work dispatched on a Scope Rate Card.
 * Visually mirrors the Scope Rate Card read-only view: collapsible sections,
 * the full column set (Category / Sub / Line Item / Qty / Unit / Vendor /
 * Vendor $), the same section-photo layout — plus two QC additions:
 *   - a Result column with Pass (check) / Fail (x) chips per line
 *   - an "After Photos" capture block (highlighted teal) alongside the
 *     source's "Before" photos
 *
 * Lines are snapshotted from the source at create time and loaded (enriched
 * with catalog category/sub/unit) via /api/inspections/[id]/qc-data.
 *
 * Submit (no approval step) -> /api/inspections/[id]/qc-finalize which renders
 * the PDF, stores verdict + counts, flips to completed (like the 1099 flow).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, formatQty } from '@/lib/photoUpload';
import { uploadPhotoOrQueue, uploadVideoEntryOrQueue, rehydrateQueuedPhotos, flushQueuedPhotos, countQueuedPhotos, discardQueuedByUrls } from '@/lib/offlinePhotoStore';
import { loadCachedQcData, saveCachedQcData } from '@/lib/offlineCache';
import { useAnyCameraOpen } from '@/lib/cameraOpenState';
import { CameraCapture } from '@/components/CameraCapture';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { vendorPillStyle, VENDORS } from '@/lib/vendors';
import { ListPicker } from '@/components/ListPicker';
import { PhotoStrip } from '@/components/PhotoStrip';
import { useAppDialog } from '@/components/AppDialog';
import { buildSectionPhotoAnswerProps, joinPhotoUrls } from '@/lib/answerProps';
import { enqueue as outboxEnqueue, isOfflineError } from '@/lib/offlineOutbox';
import { isLocalInspectionId } from '@/lib/pendingInspections';
import { drainPhotoAttachOutbox, removePhotoAttachByUrl } from '@/lib/photoAttachOutbox';
import { stampEntryWithLabel, isStamped } from '@/lib/photoStamp';
import { UnlockButton, type LockRing } from '@/components/UnlockButton';
import InspectionPager from '@/components/InspectionPager';
import { FitText } from '@/components/FitText';
import { SaveIndicator } from '@/components/inspection/SaveIndicator';
import { openPdf } from '@/lib/pdfViewerBus';

interface QcLine {
  recordId: string;
  section: string;
  location: string;
  lineItemCode: string;
  category: string;
  subcategory: string;
  unit: string;
  description: string;
  subtext?: string;
  quantity: number | null;
  vendor: string;
  vendorCost: number | null;
  passFail: 'pass' | 'fail' | '';
  photoUrls: string[];
  // Read-only comment carried over from the source Scope line (what to look for).
  scopeNote?: string;
  // The QC reviewer's explanation when this line is failed (required on fail).
  qcFailureNote?: string;
}

interface Props {
  inspectionRecordId: string;
  templateLabel: string;
  inspectorName: string;
  propertyName: string;
  /** Online/offline ring for the Unlock (lock) icon (from Rently telemetry). */
  lockRing?: LockRing;
  /** Property record id — used to validate camera GPS against the property. */
  propertyRecordId?: string;
  bedrooms: number;
  bathrooms: number;
  squareFootage: number | null;
  /** Property lifecycle status (Turnkey / Vacant / Unmarketed / …) — shown on
   *  its own line in the header. */
  propertyStatus?: string | null;
  /** Move-in Ready date from the listing (M/D/YY) — shown as "MIR: …" to the
   *  right of the property status. */
  moveInReadyDate?: string | null;
  /** Listing line (status · price · listed · Move-In far-right) — same as the
   *  other templates. Move-In shows on deposit-taken listings only. */
  listingStatus?: string | null;
  listingPrice?: number | null;
  listingDate?: string | null;
  moveInDate?: string | null;
  inspectionStatus: string;
  /** Completed QC report — shown as an in-app "View PDF Report" link. */
  pdfUrl?: string;
  readOnly: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  /** Prev/next pager: navigate to another inspection id (QC persists per-change). */
  onNavigateTo?: (id: string) => void;
  // Cancel the whole inspection (sets status to cancelled). Absent when readOnly.
  onCancelInspection?: () => void;
}

interface SectionGroup {
  key: string;
  displayName: string;
  location: string;
  section: string;
  lines: QcLine[];
  beforePhotos: string[];
}

function sectionKey(section: string, location: string) {
  return `${section || ''}||${location || ''}`;
}

export function QcReinspectForm(props: Props) {
  const dialog = useAppDialog();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lines, setLines] = useState<QcLine[]>([]);
  // Property room list (from qc-data). Used to render rooms for a STANDALONE QC
  // (no source scope → no copied lines), so after-photos can still be captured
  // per room and a final Pass/Fail set.
  const [roomList, setRoomList] = useState<{ key: string; displayName: string; section: string; location: string }[]>([]);
  const [beforeMap, setBeforeMap] = useState<Record<string, string[]>>({});
  const [afterPhotos, setAfterPhotos] = useState<Record<string, string[]>>({});
  const [afterPhotoRecordIds, setAfterPhotoRecordIds] = useState<Record<string, string>>({});
  // Standalone-QC per-room verdict + note (optional pass/fail; a Fail requires a
  // photo + note). Keyed by section key. Refs mirror them so the save path reads
  // the latest without stale closures.
  const [roomVerdict, setRoomVerdict] = useState<Record<string, 'pass' | 'fail' | ''>>({});
  const [roomNote, setRoomNote] = useState<Record<string, string>>({});
  const roomVerdictRef = useRef(roomVerdict); roomVerdictRef.current = roomVerdict;
  const roomNoteRef = useRef(roomNote); roomNoteRef.current = roomNote;
  const [verdict, setVerdict] = useState<'pass' | 'fail' | ''>('');
  // Overall failure comment — REQUIRED when the verdict is Fail; carried onto the
  // QC PDF so the vendor/MC see why the re-inspect failed overall.
  const [overallNote, setOverallNote] = useState('');
  // Maintenance ticket for NEW items found on re-inspect that were NOT on the
  // original scope (distinct from line pass/fail — see the widget callout). Yes +
  // a required description raises a maintenance ticket on submit.
  const [maintTicketWanted, setMaintTicketWanted] = useState<'' | 'Yes' | 'No'>('');
  const [maintTicketDescription, setMaintTicketDescription] = useState('');
  const maintAnswerRecordIdsRef = useRef<{ request?: string; description?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  // Synchronous re-entry guard: `disabled={submitting}` only blocks taps AFTER
  // the next render, so a fast double-tap could fire two qc-finalize POSTs in
  // the same frame. The ref blocks the second call immediately.
  const submittingRef = useRef(false);
  const [result, setResult] = useState<null | { verdict: string; passCount: number; failCount: number; pdf: { name: string; url: string }; resultSync?: { verdictSynced: boolean; inspectionResultSynced: boolean; fields: string[] }; ticket?: { ok: boolean; url?: string | null; error?: string } | null }>(null);
  const [cameraKey, setCameraKey] = useState<string | null>(null);
  // While a camera overlay is open, don't render before/after thumbnails — keeps
  // them from sitting decoded in memory under the camera (the iOS WebKit crash).
  const cameraOpenAnywhere = useAnyCameraOpen();
  // Photo viewer (swipe / markup / delete / tag-to-line / video). `phase`
  // distinguishes the read-only source "before" photos from editable "after".
  const [qcLightbox, setQcLightbox] = useState<{ phase: 'before' | 'after'; key: string; index: number } | null>(null);
  // Per-section photo collapse — Before + After share one state so collapsing
  // either folds both.
  const [photosCollapsed, setPhotosCollapsed] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Real-time save status indicator (mirrors the Scope Rate Card).
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // In-flight QC writes (line pass/fail, room verdict/note, photo tags). The
  // submit gate waits for this to reach 0 so a verdict/note save can't be lost
  // to an in-flight write at finalize. Bumped via markSaving/markSaved/markSaveError.
  const qcInFlightRef = useRef(0);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Audit: log ONE "Edited" event per editing session (first successful save),
  // re-armed after the app is re-entered following an absence. Best-effort.
  const editAuditLoggedRef = useRef(false);
  function logEditOnce() {
    if (editAuditLoggedRef.current) return;
    editAuditLoggedRef.current = true;
    try {
      void fetch(`/api/inspections/${props.inspectionRecordId}/audit-edit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true,
      }).catch(() => { /* best-effort — never blocks editing */ });
    } catch { /* ignore */ }
  }

  function markSaving() { qcInFlightRef.current++; setSaveStatus('saving'); }
  function markSaved() {
    qcInFlightRef.current = Math.max(0, qcInFlightRef.current - 1);
    logEditOnce(); // first save of the session → record an "Edited" audit event
    setSaveStatus('saved');
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
  }
  function markSaveError() { qcInFlightRef.current = Math.max(0, qcInFlightRef.current - 1); setSaveStatus('error'); }
  useEffect(() => () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current); }, []);
  // Re-arm the once-per-session edit log when the app is re-entered after >60s away.
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 60_000) editAuditLoggedRef.current = false;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      // Apply a qc-data payload (live or cached) to state.
      const apply = (d: any) => {
        const loadedLines: QcLine[] = d.lines || [];
        setLines(loadedLines);
        setRoomList(Array.isArray(d.sections) ? d.sections : []);
        setBeforeMap(d.beforePhotos || {});
        const after: Record<string, string[]> = {};
        const afterIds: Record<string, string> = {};
        const roomV: Record<string, 'pass' | 'fail' | ''> = {};
        const roomN: Record<string, string> = {};
        for (const [key, v] of Object.entries(d.afterPhotos || {})) {
          const val = v as { recordId: string; urls: string[]; passFail?: string; note?: string };
          after[key] = val.urls || [];
          afterIds[key] = val.recordId;
          if (val.passFail === 'pass' || val.passFail === 'fail') roomV[key] = val.passFail;
          if (val.note) roomN[key] = val.note;
        }
        setAfterPhotos(after);
        setAfterPhotoRecordIds(afterIds);
        setRoomVerdict(roomV);
        setRoomNote(roomN);
        if (d.qcVerdict === 'pass' || d.qcVerdict === 'fail') setVerdict(d.qcVerdict);
        if (typeof d.qcOverallNote === 'string') setOverallNote(d.qcOverallNote);
        // Restore the maintenance-ticket selection + description on reopen.
        if (/^y/i.test(d.maintTicketWanted || '')) setMaintTicketWanted('Yes');
        else if (/^n/i.test(d.maintTicketWanted || '')) setMaintTicketWanted('No');
        if (typeof d.maintTicketDescription === 'string') setMaintTicketDescription(d.maintTicketDescription);
        maintAnswerRecordIdsRef.current = {
          request: d.maintTicketRequestRecordId || undefined,
          description: d.maintTicketDescriptionRecordId || undefined,
        };

        // Default: all sections expanded so the reviewer can see every line
        // item at a glance. (They can still collapse individually.)
        setCollapsed(new Set());
      };
      try {
        const r = await fetch(`/api/inspections/${props.inspectionRecordId}/qc-data`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
        apply(d);
        saveCachedQcData(props.inspectionRecordId, d); // warm offline cache
      } catch (e: any) {
        // Offline / fetch failed → fall back to the cached qc-data so the
        // re-inspect still opens; Pass/Fail + after-photos queue and sync later.
        const cached = loadCachedQcData(props.inspectionRecordId);
        if (cached && !cancelled) { apply(cached); }
        else if (!cancelled) { setLoadError(String(e?.message || e)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [props.inspectionRecordId]);

  const sections: SectionGroup[] = useMemo(() => {
    // STANDALONE QC (no source scope → no copied lines): render the property's
    // rooms with empty lines/before-photos so after-photos can still be captured.
    if (lines.length === 0) {
      return roomList.map((r) => ({
        key: r.key,
        displayName: r.displayName || r.section || 'Room',
        location: r.location,
        section: r.section,
        lines: [],
        beforePhotos: beforeMap[r.key] || beforeMap[r.location] || beforeMap[r.section] || [],
      }));
    }
    const order: string[] = [];
    const map = new Map<string, SectionGroup>();
    for (const ln of lines) {
      const key = sectionKey(ln.section, ln.location);
      if (!map.has(key)) {
        order.push(key);
        const before = beforeMap[key] || beforeMap[ln.location] || beforeMap[ln.section] || [];
        map.set(key, {
          key,
          displayName: ln.location || ln.section || 'Section',
          location: ln.location,
          section: ln.section,
          lines: [],
          beforePhotos: before,
        });
      }
      map.get(key)!.lines.push(ln);
    }
    return order.map((k) => map.get(k)!);
  }, [lines, beforeMap, roomList]);

  // Distinct vendors actually assigned on this reinspect, ordered by the
  // canonical VENDORS list (then any extras). Drives the header filter dropdown.
  const assignedVendors = useMemo(() => {
    const present = new Set<string>();
    for (const l of lines) { const v = (l.vendor || '').trim(); if (v) present.add(v); }
    return [...VENDORS.filter((v) => present.has(v)), ...Array.from(present).filter((v) => !VENDORS.includes(v))];
  }, [lines]);
  const [vendorFilter, setVendorFilter] = useState<string>('All');
  // Guard: if the selected vendor no longer has any lines, fall back to All.
  const activeVendorFilter = vendorFilter !== 'All' && assignedVendors.includes(vendorFilter) ? vendorFilter : 'All';

  // Sections to render — narrowed to the selected vendor's lines, hiding any
  // section that has none of them. Keeps the same key/photos so collapse state
  // and before/after photo maps still line up.
  const visibleSections = useMemo(() => {
    if (activeVendorFilter === 'All') return sections;
    return sections
      .map((s) => ({ ...s, lines: s.lines.filter((l) => (l.vendor || '').trim() === activeVendorFilter) }))
      .filter((s) => s.lines.length > 0);
  }, [sections, activeVendorFilter]);

  // Counts include BOTH scope line verdicts AND standalone per-room verdicts
  // (they're mutually exclusive: a scope QC has lines, a standalone QC has room
  // verdicts), so the header/section chips update as rooms are marked.
  const totalPass = lines.filter((l) => l.passFail === 'pass').length
    + sections.filter((s) => (roomVerdict[s.key] || '') === 'pass').length;
  const totalFail = lines.filter((l) => l.passFail === 'fail').length
    + sections.filter((s) => (roomVerdict[s.key] || '') === 'fail').length;
  // STANDALONE QC (no copied lines): nothing to mark and after-photos are
  // OPTIONAL, so only the final Pass/Fail verdict gates submit. With a source
  // scope, every line must be marked and every room needs an after-photo.
  const hasLines = lines.length > 0;
  const allMarked = !hasLines || lines.every((l) => l.passFail === 'pass' || l.passFail === 'fail');
  const allSectionsHaveAfter = !hasLines || sections.every((s) => (afterPhotos[s.key] || []).length > 0);
  // Standalone QC: per-room Pass/Fail is optional, but a room marked FAIL needs
  // at least one After photo AND a note before submitting.
  const standaloneFailRoomsOk = hasLines || sections.every((s) => {
    if ((roomVerdict[s.key] || '') !== 'fail') return true;
    return (afterPhotos[s.key] || []).length > 0 && (roomNote[s.key] || '').trim().length > 0;
  });

  // Status pill shown next to the title (mirrors Scope / 1099 headers).
  const statusLabel = (() => {
    switch ((props.inspectionStatus || '').toLowerCase()) {
      case 'scheduled': return { label: 'Scheduled', color: 'bg-blue-100 text-blue-800 border-blue-200' };
      case 'in_progress': return { label: 'In Progress', color: 'bg-amber-100 text-amber-800 border-amber-200' };
      case 'pending_approval': return { label: 'Pending Approval', color: 'bg-purple-100 text-purple-800 border-purple-200' };
      case 'completed': return { label: 'Completed', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
      case 'cancelled': return { label: 'Cancelled', color: 'bg-gray-100 text-gray-700 border-gray-200' };
      default: return null;
    }
  })();

  // Offline-aware uploader for the in-app camera — caches to IndexedDB on a weak
  // signal and returns a draft URL, tagged to the camera's active section so it
  // re-attaches on sync. cameraKey tracks the room being shot.
  const uploadHelper = useCallback(
    (file: File) => {
      const key = cameraKey || '';
      // Durable background attach (same mechanism as scope/question): the QC
      // after-photo's section_photo record is keyed deterministically (matches
      // persistAfterPhotos). The server's section attach updates ONLY the photo
      // list, so the room's pass/fail + note are preserved. `key` is
      // "section||location".
      const [section, location] = key.split('||');
      return uploadPhotoOrQueue(file, props.inspectionRecordId, key, {
        attach: { kind: 'section', externalId: `QCAFTER-${props.inspectionRecordId}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`, section: section || '', location: location || '', summaryLabel: section || '' },
      });
    },
    [props.inspectionRecordId, cameraKey],
  );

  function toggleCollapse(key: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const allCollapsed = sections.length > 0 && sections.every((s) => collapsed.has(s.key));
  function setAllCollapsed(c: boolean) {
    setCollapsed(c ? new Set(sections.map((s) => s.key)) : new Set());
  }

  async function persistAfterPhotos(key: string, section: string, location: string, urlsIn: string[]) {
    // Never POST offline draft (blob:) URLs to HubSpot — they're local only and
    // get swapped for the real URL when the queue flushes on reconnect.
    const urls = urlsIn.filter((u) => !u.startsWith('blob:'));
    const existingId = afterPhotoRecordIds[key];
    // DETERMINISTIC external id (was a random uuid): `key` (section||location) is
    // already unique per inspection, so a stable id lets an offline replay upsert
    // idempotently instead of creating a duplicate record.
    const externalId = `QCAFTER-${props.inspectionRecordId}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const body = {
      upserts: [{
        recordId: existingId,
        answerProps: buildSectionPhotoAnswerProps({
          answerIdExternal: externalId,
          section,
          summaryLabel: section,
          location,
          photoUrls: urls,
          photoPhase: 'after' as const,
          // Standalone-QC room verdict + note ride on this same record.
          passFail: roomVerdictRef.current[key] || '',
          note: roomNoteRef.current[key] || '',
        }),
        questionHubspotRecordId: null,
      }],
      bumpStatusToInProgress: true,
    };
    markSaving();
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`Save after-photos failed: HTTP ${r.status}`);
      const data = await r.json();
      const newId = data?.results?.[0]?.recordId;
      if (newId && !existingId) setAfterPhotoRecordIds((cur) => ({ ...cur, [key]: newId }));
      markSaved();
    } catch (e: any) {
      // Offline / transient: QUEUE the write durably so the change — an ADD, a
      // DELETE, or a room verdict/note — survives and syncs when back online
      // (previously it was lost, so deleted photos reappeared on reconnect). The
      // offline banner already conveys "saved offline", so DON'T alert here. A
      // genuine 4xx rethrows so the caller can surface a real error.
      if (isOfflineError(e)) {
        outboxEnqueue({ inspectionRecordId: props.inspectionRecordId, endpoint: `/api/inspections/${props.inspectionRecordId}/answers`, method: 'POST', body, kind: 'sectionPhoto', meta: { sectionId: key } });
        markSaved();
        return;
      }
      markSaveError();
      throw e;
    }
  }

  // Persist the maintenance-ticket Q&A (new-items-not-on-scope) as synthetic qa
  // answers so they appear on the record and round-trip on reopen. Mirrors the
  // 1099/vacancy maint_ticket_request / maint_ticket_description answers, keyed by
  // record id (QC has no inspectionExternalId). Throws on failure so submit blocks.
  async function persistMaintTicket(): Promise<void> {
    if (maintTicketWanted !== 'Yes' && maintTicketWanted !== 'No') return; // no choice → nothing to save
    const mk = (qid: 'maint_ticket_request' | 'maint_ticket_description', value: string, slot: 'request' | 'description') => ({
      recordId: maintAnswerRecordIdsRef.current[slot] || undefined,
      answerProps: {
        answer_id_external: `QCMAINT-${props.inspectionRecordId}-${slot}`,
        answer_type: 'qa',
        section: 'Maintenance Ticket',
        answer_summary: 'Maintenance Ticket / New items not on original scope',
        answer_value: (value || '').slice(0, 65000),
        question_id_external: qid,
        submitted_at: new Date().toISOString(),
      },
      questionHubspotRecordId: null,
    });
    const upserts = [mk('maint_ticket_request', maintTicketWanted, 'request')];
    if (maintTicketWanted === 'Yes' && maintTicketDescription.trim()) {
      upserts.push(mk('maint_ticket_description', maintTicketDescription.trim(), 'description'));
    }
    const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upserts, archives: [], bumpStatusToInProgress: true }),
    });
    if (!r.ok) throw new Error(`Save maintenance-ticket answer failed: HTTP ${r.status}`);
    const data = await r.json().catch(() => ({} as any));
    for (const res of (data.results || []) as Array<{ recordId: string; answerIdExternal: string }>) {
      if (res.answerIdExternal?.endsWith('-request')) maintAnswerRecordIdsRef.current.request = res.recordId;
      else if (res.answerIdExternal?.endsWith('-description')) maintAnswerRecordIdsRef.current.description = res.recordId;
    }
  }

  async function addAfterPhotos(key: string, section: string, location: string, newUrls: string[]) {
    if (newUrls.length === 0) return;
    const merged = [...(afterPhotos[key] || []), ...newUrls];
    setAfterPhotos((cur) => ({ ...cur, [key]: merged }));
    try { await persistAfterPhotos(key, section, location, merged); }
    catch (e: any) { if (!isOfflineError(e)) void dialog.alert(`Could not save photos: ${e?.message || e}`); }
  }

  async function removeAfterPhoto(key: string, section: string, location: string, url: string) {
    const merged = (afterPhotos[key] || []).filter((u) => u !== url);
    setAfterPhotos((cur) => ({ ...cur, [key]: merged }));
    try { await persistAfterPhotos(key, section, location, merged); }
    catch (e: any) { if (!isOfflineError(e)) void dialog.alert(`Could not update photos: ${e?.message || e}`); }
    // Keep line tags in sync — a deleted After photo can't stay on a line.
    const sec = sections.find((s) => s.key === key);
    for (const line of (sec?.lines || [])) {
      if ((line.photoUrls || []).includes(url)) {
        await saveLinePhotos(line.recordId, (line.photoUrls || []).filter((u) => u !== url));
      }
    }
  }

  // Standalone-QC room verdict (optional). Toggling off a set verdict clears it.
  // The verdict rides on the room's after-photo record (persistAfterPhotos).
  function setRoomPassFail(key: string, section: string, location: string, pf: 'pass' | 'fail') {
    if (props.readOnly) return;
    const next = (roomVerdictRef.current[key] === pf ? '' : pf) as 'pass' | 'fail' | '';
    const updated = { ...roomVerdictRef.current, [key]: next };
    roomVerdictRef.current = updated;
    setRoomVerdict(updated);
    void persistAfterPhotos(key, section, location, afterPhotos[key] || [])
      .catch((e) => console.warn('[QC] room verdict save failed:', e));
  }
  function setRoomNoteText(key: string, text: string) {
    const updated = { ...roomNoteRef.current, [key]: text };
    roomNoteRef.current = updated;
    setRoomNote(updated);
  }
  // Persist the room note (called on blur) onto the room's after-photo record.
  function saveRoomNote(key: string, section: string, location: string) {
    if (props.readOnly) return;
    void persistAfterPhotos(key, section, location, afterPhotos[key] || [])
      .catch((e) => console.warn('[QC] room note save failed:', e));
  }

  // Persist a QC line's photo_urls to its answer record (shared by tag/untag).
  async function saveLinePhotos(lineRecordId: string, urls: string[]) {
    setLines((cur) => cur.map((l) => (l.recordId === lineRecordId ? { ...l, photoUrls: urls } : l)));
    // Persist only real URLs — offline drafts (blob:) sync + swap on reconnect.
    const real = urls.filter((u) => !u.startsWith('blob:'));
    const body = {
      upserts: [{
        recordId: lineRecordId,
        answerProps: { photo_urls: joinPhotoUrls(real), photo_count: real.length },
        questionHubspotRecordId: null,
      }],
    };
    try {
      markSaving();
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      markSaved();
    } catch (e: any) {
      // Offline / transient: queue the line-tag change durably (no popup); the
      // offline pill conveys it. Genuine error → inline "Save failed" only.
      if (isOfflineError(e)) {
        outboxEnqueue({ inspectionRecordId: props.inspectionRecordId, endpoint: `/api/inspections/${props.inspectionRecordId}/answers`, method: 'POST', body, kind: 'line', meta: { line: { recordId: lineRecordId } } });
        markSaved();
      } else {
        markSaveError();
      }
    }
  }

  // Tag a freshly-captured photo to a QC line FROM INSIDE THE CAMERA
  // (non-destructive — attaches the photo to the line record, returns url as-is).
  async function tagCameraPhotoToLineQc(url: string, lineRecordId: string): Promise<string> {
    const line = lines.find((l) => l.recordId === lineRecordId);
    if (!line) return url;
    const linePhotos = line.photoUrls || [];
    if (!linePhotos.includes(url)) await saveLinePhotos(lineRecordId, [...linePhotos, url]);
    return url;
  }

  // Swap an After photo for its marked-up version (re-upload + replace, persist).
  async function replaceAfterPhoto(key: string, section: string, location: string, index: number, file: File) {
    try {
      const oldForReplace = (afterPhotos[key] || [])[index];
      // Annotating an un-synced draft: discard the original queued draft so it and
      // the annotated copy don't BOTH upload+attach (duplicate photo).
      if (oldForReplace && oldForReplace.startsWith('blob:')) { try { await discardQueuedByUrls([oldForReplace]); removePhotoAttachByUrl([oldForReplace]); } catch { /* best-effort */ } }
      const url = await uploadPhotoOrQueue(file, props.inspectionRecordId, key, { replacesUrl: oldForReplace });
      const arr = [...(afterPhotos[key] || [])];
      if (index < 0 || index >= arr.length) return;
      const oldUrl = arr[index];
      arr[index] = url;
      setAfterPhotos((cur) => ({ ...cur, [key]: arr }));
      await persistAfterPhotos(key, section, location, arr);
      // Keep line tags in sync — swap the old URL for the marked-up one.
      if (oldUrl && oldUrl !== url) {
        const sec = sections.find((s) => s.key === key);
        for (const line of (sec?.lines || [])) {
          if ((line.photoUrls || []).includes(oldUrl)) {
            await saveLinePhotos(line.recordId, (line.photoUrls || []).map((u) => (u === oldUrl ? url : u)));
          }
        }
      }
    } catch (e: any) { if (!isOfflineError(e)) void dialog.alert(`Could not update photo: ${e?.message || e}`); }
  }

  // Tag/untag an After photo to/from a QC line (non-destructive). The photo
  // stays in the After strip; only the line's photo_urls change.
  async function tagAfterPhotoToLine(key: string, index: number, lineRecordId: string) {
    const url = (afterPhotos[key] || [])[index];
    const line = lines.find((l) => l.recordId === lineRecordId);
    if (!url || !line) return;
    const linePhotos = line.photoUrls || [];
    if (!linePhotos.includes(url)) await saveLinePhotos(lineRecordId, [...linePhotos, url]);
  }
  async function untagAfterPhotoFromLine(key: string, index: number, lineRecordId: string) {
    const url = (afterPhotos[key] || [])[index];
    const line = lines.find((l) => l.recordId === lineRecordId);
    if (!url || !line) return;
    await saveLinePhotos(lineRecordId, (line.photoUrls || []).filter((u) => u !== url));
  }

  // ---- Offline photo cache + auto-sync ----------------------------------
  // Captures on a weak signal are cached to IndexedDB (draft blob: URLs) and
  // re-attached + persisted when connectivity returns. Mirrors RateCardForm.
  const afterPhotosRef = useRef(afterPhotos); afterPhotosRef.current = afterPhotos;
  const linesRef = useRef(lines); linesRef.current = lines;
  const persistRef = useRef(persistAfterPhotos); persistRef.current = persistAfterPhotos;
  const saveLineRef = useRef(saveLinePhotos); saveLineRef.current = saveLinePhotos;
  const rehydratedRef = useRef(false);

  const runQcFlush = async () => {
    if (!rehydratedRef.current) return undefined; // wait until drafts are in state to swap
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return undefined;
    // ONE swap map (draft AND any replaced original -> real url) applied to BOTH
    // after-photos and lines — a section After photo can be TAGGED onto a line, so
    // its blob lives in both places and must swap in both. Plus a durability net:
    // every plain (non-annotation) synced photo is APPENDED to its section if the
    // swap didn't find its draft (e.g. state drifted after a reload), so an
    // uploaded photo is never orphaned — the QC photo-loss + "can't submit
    // because a draft blob lingers" bug.
    const swaps = new Map<string, string>();
    const sectionAdds: { key: string; newUrl: string }[] = [];
    const flushResult = await flushQueuedPhotos(props.inspectionRecordId, ({ sectionId, oldUrl, newUrl, replacesUrl, lineExternalId }) => {
      if (oldUrl) swaps.set(oldUrl, newUrl);
      if (replacesUrl) swaps.set(replacesUrl, newUrl);
      // A brand-new section After photo (QC has no per-line photo queue) — ensure
      // it lands on its room even if the swap matches nothing. lineExternalId is
      // unused by QC captures, but guard anyway.
      if (!replacesUrl && !lineExternalId) sectionAdds.push({ key: sectionId, newUrl });
    }).catch(() => ({ synced: 0, remaining: 0 } as any));

    // ---- after-photos: swap matched drafts, then append any un-attached adds ----
    {
      const cur = afterPhotosRef.current;
      const next: Record<string, string[]> = { ...cur };
      const persistKeys = new Set<string>();
      for (const [k, urls] of Object.entries(cur)) {
        let changed = false;
        const sw = urls.map((u) => { const r = swaps.get(u); if (r) { changed = true; return r; } return u; });
        if (changed) { next[k] = sw; persistKeys.add(k); }
      }
      for (const add of sectionAdds) {
        const arr = next[add.key] || [];
        if (!arr.includes(add.newUrl)) { next[add.key] = [...arr, add.newUrl]; persistKeys.add(add.key); }
      }
      if (persistKeys.size) {
        setAfterPhotos(next);
        for (const k of persistKeys) { const [section, location] = k.split('||'); void persistRef.current(k, section, location || '', next[k]); }
      }
    }

    // ---- lines: swap the same map so a tagged After photo's blob becomes its
    // real url on the line too (else the burn-label step keeps a dead blob) ----
    if (swaps.size) {
      const cur = linesRef.current;
      const toSave: { id: string; urls: string[] }[] = [];
      const next = cur.map((l) => {
        const photos = l.photoUrls || [];
        let changed = false;
        const sw = photos.map((u) => { const r = swaps.get(u); if (r) { changed = true; return r; } return u; });
        if (!changed) return l;
        toSave.push({ id: l.recordId, urls: sw });
        return { ...l, photoUrls: sw };
      });
      if (toSave.length) { setLines(next); for (const t of toSave) void saveLineRef.current(t.id, t.urls); }
    }
    // Drain this inspection's durable photo-attach backups (the global driver
    // skips the OPEN inspection, so they'd otherwise keep the sync badge showing
    // "Syncing N…" while the form is open). Idempotent append.
    try { await drainPhotoAttachOutbox(); } catch { /* retries via global driver */ }
    return flushResult;
  };
  const runQcFlushRef = useRef(runQcFlush); runQcFlushRef.current = runQcFlush;

  // Rehydrate queued drafts into state once the record has loaded, then drain.
  useEffect(() => {
    if (loading || rehydratedRef.current) return;
    rehydratedRef.current = true;
    void rehydrateQueuedPhotos(props.inspectionRecordId).then((drafts) => {
      if (drafts.length) {
        const bySection: Record<string, string[]> = {};
        const byLine: Record<string, string[]> = {};
        for (const d of drafts) {
          if (d.lineExternalId) (byLine[d.lineExternalId] = byLine[d.lineExternalId] || []).push(d.url);
          else (bySection[d.sectionId] = bySection[d.sectionId] || []).push(d.url);
        }
        if (Object.keys(bySection).length) setAfterPhotos((cur) => { const n = { ...cur }; for (const [k, urls] of Object.entries(bySection)) n[k] = Array.from(new Set([...(n[k] || []), ...urls])); return n; });
        if (Object.keys(byLine).length) setLines((cur) => cur.map((l) => byLine[l.recordId] ? { ...l, photoUrls: Array.from(new Set([...(l.photoUrls || []), ...byLine[l.recordId]])) } : l));
      }
    }).catch(() => {}).finally(() => { void runQcFlushRef.current(); });
  }, [loading, props.inspectionRecordId]);

  // Auto-retry: flush on reconnect + a periodic reconcile.
  useEffect(() => {
    const onOnline = () => { void runQcFlushRef.current(); };
    window.addEventListener('online', onOnline);
    const iv = setInterval(() => { void runQcFlushRef.current(); }, 15000);
    return () => { window.removeEventListener('online', onOnline); clearInterval(iv); };
  }, []);
  // Which of a section's lines the After photo at `index` is tagged to.
  function currentTagsForAfter(key: string, index: number): { externalId: string; label: string }[] {
    const url = (afterPhotos[key] || [])[index];
    if (!url) return [];
    const sec = sections.find((s) => s.key === key);
    return (sec?.lines || [])
      .filter((l) => (l.photoUrls || []).includes(url))
      .map((l) => ({ externalId: l.recordId, label: l.description || l.lineItemCode }));
  }

  async function setLinePassFail(line: QcLine, pf: 'pass' | 'fail') {
    const next = line.passFail === pf ? '' : pf;
    setLines((cur) => cur.map((l) => (l.recordId === line.recordId
      // Leaving 'fail' clears the failure note (it no longer applies).
      ? { ...l, passFail: next, qcFailureNote: next === 'fail' ? l.qcFailureNote : '' }
      : l)));
    const body = {
      upserts: [{ recordId: line.recordId, answerProps: { pass_fail: next }, questionHubspotRecordId: null }],
      bumpStatusToInProgress: true,
    };
    markSaving();
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      markSaved();
    } catch (e: any) {
      // Offline / transient: QUEUE the pass/fail durably so it syncs when back
      // online, and KEEP the optimistic selection (reverting it silently lost the
      // inspector's tap). The offline banner conveys "saved offline" — never pop
      // a "Could not save" dialog (it's noise in the field on every weak request).
      if (isOfflineError(e)) {
        outboxEnqueue({ inspectionRecordId: props.inspectionRecordId, endpoint: `/api/inspections/${props.inspectionRecordId}/answers`, method: 'POST', body, kind: 'line', meta: { line: { recordId: line.recordId } } });
        markSaved();
      } else {
        // Genuine error: show the inline "Save failed" indicator only — no popup.
        markSaveError();
        setLines((cur) => cur.map((l) => (l.recordId === line.recordId ? { ...l, passFail: line.passFail } : l)));
      }
    }
    if (next !== 'fail' && line.qcFailureNote) void saveFailureNote(line.recordId, ''); // best-effort clear
  }

  // Local edit of a fail line's note (persisted on blur via saveFailureNote).
  function updateFailureNote(recordId: string, text: string) {
    setLines((cur) => cur.map((l) => (l.recordId === recordId ? { ...l, qcFailureNote: text } : l)));
  }

  // Persist a line's QC failure note. Separate from pass/fail so a missing
  // qc_failure_note property (pre-/admin/setup) can't break pass/fail saving.
  async function saveFailureNote(recordId: string, text: string) {
    const body = {
      upserts: [{ recordId, answerProps: { qc_failure_note: text }, questionHubspotRecordId: null }],
      bumpStatusToInProgress: true,
    };
    markSaving();
    try {
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      markSaved();
    } catch (e: any) {
      // Offline / transient: queue durably so the note syncs, no popup (the
      // offline pill conveys it). Genuine error → inline "Save failed" only.
      if (isOfflineError(e)) {
        outboxEnqueue({ inspectionRecordId: props.inspectionRecordId, endpoint: `/api/inspections/${props.inspectionRecordId}/answers`, method: 'POST', body, kind: 'line', meta: { line: { recordId } } });
        markSaved();
      } else {
        markSaveError();
      }
    }
  }

  // Burn each tagged After photo's line label into the image before submit, so
  // the QC PDF shows which line each photo evidences (idempotent; tagging stays
  // non-destructive until this terminal step).
  async function burnTaggedLabelsQc() {
    for (const sec of sections) {
      if (sec.lines.length === 0) continue;
      const after = [...(afterPhotos[sec.key] || [])];
      const swaps = new Map<string, string>();
      for (let i = 0; i < after.length; i++) {
        const url = after[i];
        if (isStamped(url)) continue;
        const taggedLines = sec.lines.filter((l) => (l.photoUrls || []).includes(url));
        if (taggedLines.length === 0) continue;
        const label = taggedLines.map((l) => l.description || l.lineItemCode).join(' · ');
        try {
          const stamped = await stampEntryWithLabel(url, label);
          if (stamped && stamped !== url) { after[i] = stamped; swaps.set(url, stamped); }
        } catch (e) { console.warn('[QC burnTaggedLabels] stamp failed:', e); }
      }
      if (swaps.size > 0) {
        setAfterPhotos((cur) => ({ ...cur, [sec.key]: after }));
        await persistAfterPhotos(sec.key, sec.section, sec.location, after);
        for (const line of sec.lines) {
          if (!(line.photoUrls || []).some((u) => swaps.has(u))) continue;
          await saveLinePhotos(line.recordId, (line.photoUrls || []).map((u) => swaps.get(u) || u));
        }
      }
    }
  }

  async function handleSubmit() {
    if (submittingRef.current) return;
    if (isLocalInspectionId(props.inspectionRecordId)) {
      void dialog.alert('This inspection is still finishing its first sync to the server. It’ll be ready to submit in a moment once you have a connection — your work is saved.');
      return;
    }
    if (!allMarked) { void dialog.alert('Every line item must be marked Pass or Fail before submitting.'); return; }
    // A failed line MUST have a note explaining what failed (for the vendor/MC).
    const failMissingNote = lines.find((l) => l.passFail === 'fail' && !(l.qcFailureNote || '').trim());
    if (failMissingNote) {
      void dialog.alert(`Add a note on every FAILED line explaining what failed and what's needed to correct it.\n\nMissing: ${failMissingNote.description || failMissingNote.lineItemCode}`);
      return;
    }
    if (!allSectionsHaveAfter) { void dialog.alert('Every section needs at least one After Photo before submitting.'); return; }
    if (!standaloneFailRoomsOk) {
      const bad = sections.find((s) => (roomVerdict[s.key] || '') === 'fail' && ((afterPhotos[s.key] || []).length === 0 || !(roomNote[s.key] || '').trim()));
      void dialog.alert(`A room marked FAIL needs at least one After photo and a note.\n\nMissing: ${bad?.displayName || 'a failed room'}`);
      return;
    }
    if (verdict !== 'pass' && verdict !== 'fail') { void dialog.alert('Select an overall Pass or Fail verdict.'); return; }
    // A failing overall verdict REQUIRES a comment — it prints on the QC PDF.
    if (verdict === 'fail' && !overallNote.trim()) {
      void dialog.alert('Add an overall failure comment explaining why the re-inspect failed — it’s included on the report.');
      return;
    }
    // Maintenance ticket (new items not on the original scope): if they chose Yes,
    // the description is required (it becomes the ticket body).
    if (maintTicketWanted === 'Yes' && !maintTicketDescription.trim()) {
      void dialog.alert('Enter the maintenance ticket description for the new item(s) found, or choose “No”.');
      return;
    }
    // Don't finalize while After photos are still uploading — qc-finalize re-reads
    // the answers from HubSpot to build the report, so a queued (unsynced) photo
    // would be missing from the record. Retry, then HARD-BLOCK while pending;
    // only allow finalizing without them when a photo is genuinely stuck.
    {
      // Count After photos that haven't uploaded yet. countQueuedPhotos reads
      // IndexedDB and returns 0 on error/timeout (iOS under storage pressure), so
      // ALSO count in-memory draft (blob:) URLs across every room — those are not
      // saved and persistAfterPhotos would silently DROP them. Block on either
      // signal so unsynced After photos can never be lost at submit.
      const countUnsyncedAfter = () => sections.reduce((n, s) =>
        n + (afterPhotosRef.current[s.key] || []).filter((u) => typeof u === 'string' && u.startsWith('blob:')).length, 0);
      let pendingPhotos = 0;
      let lastErr: string | undefined;
      for (let i = 0; i < 5; i++) {
        try { const fr = await runQcFlushRef.current(); lastErr = (fr as any)?.lastError; } catch { /* checked below */ }
        let queued = 0;
        try { queued = await countQueuedPhotos(props.inspectionRecordId); } catch { queued = 0; }
        pendingPhotos = Math.max(queued, countUnsyncedAfter());
        if (pendingPhotos === 0) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (pendingPhotos > 0) {
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (offline) {
          void dialog.alert(`${pendingPhotos} After photo${pendingPhotos === 1 ? '' : 's'} still need${pendingPhotos === 1 ? 's' : ''} to upload, but you're offline. Move to signal and stay on this screen until they finish — they aren't saved yet.`);
          return;
        }
        const stuck = /failed to upload\s*\d+/i.test(lastErr || '');
        if (!stuck) {
          void dialog.alert(`${pendingPhotos} After photo${pendingPhotos === 1 ? '' : 's'} ${pendingPhotos === 1 ? 'is' : 'are'} still uploading. Keep this screen open a few more seconds, then submit again — ${pendingPhotos === 1 ? "it isn't" : "they aren't"} saved yet.`);
          return;
        }
        const proceed = await dialog.confirm(`${pendingPhotos} After photo${pendingPhotos === 1 ? '' : 's'} keep${pendingPhotos === 1 ? 's' : ''} failing to upload (check your signal). If you submit now ${pendingPhotos === 1 ? 'it' : 'they'} will NOT be on the report. Submit without ${pendingPhotos === 1 ? 'it' : 'them'}?`, { confirmLabel: 'Submit without photos', cancelLabel: 'Keep trying' });
        if (!proceed) return;
      }
    }
    // Authoritatively re-save every room's verdict / note / after-photos — per-tap
    // room saves are best-effort (errors were only logged) and qc-finalize re-reads
    // from HubSpot, so this guarantees the latest results are persisted, and BLOCKS
    // submit if they can't be — never finalizing on stale/lost room data.
    try {
      for (const s of sections) {
        const hasData = !!(roomVerdictRef.current[s.key] || (roomNoteRef.current[s.key] || '').trim() || (afterPhotosRef.current[s.key] || []).length);
        if (hasData) await persistAfterPhotos(s.key, s.section, s.location, afterPhotosRef.current[s.key] || []);
      }
      // Persist the maintenance-ticket selection + description (new items not on
      // the original scope) so it's on the record before finalize.
      await persistMaintTicket();
    } catch (e: any) {
      void dialog.alert(`Could not save the latest room results before submitting (${e?.message || e}). Your inspection was NOT submitted — check your connection and try Submit again.`);
      return;
    }
    // Wait for any in-flight line pass/fail + note saves to confirm before finalize.
    for (let i = 0; i < 24 && qcInFlightRef.current > 0; i++) { await new Promise((r) => setTimeout(r, 250)); }
    if (qcInFlightRef.current > 0) {
      void dialog.alert('Your latest results are still saving. Keep this screen open a few more seconds, then submit again.');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await burnTaggedLabelsQc();
      const r = await fetch(`/api/inspections/${props.inspectionRecordId}/qc-finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, overallNote: verdict === 'fail' ? overallNote.trim() : '' }),
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`); }
      const finalizeData = await r.json();
      // Raise a maintenance ticket for the NEW items (best-effort — never blocks
      // completion). The QC is already finalized at this point; surface the result.
      let ticket: { ok: boolean; url?: string | null; error?: string } | null = null;
      if (maintTicketWanted === 'Yes' && maintTicketDescription.trim()) {
        try {
          const tr = await fetch(`/api/inspections/${props.inspectionRecordId}/create-inspection-ticket`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: maintTicketDescription.trim() }),
          });
          const td = await tr.json().catch(() => ({} as any));
          ticket = td?.ok ? { ok: true, url: td.url } : { ok: false, error: td?.error || `HTTP ${tr.status}` };
        } catch (e: any) {
          ticket = { ok: false, error: String(e?.message || e).slice(0, 200) };
        }
      }
      setResult({ ...finalizeData, ticket });
    } catch (e: any) {
      void dialog.alert(`Submit failed: ${e?.message || e}`);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading inspection...</div>;
  if (loadError) return <div className="text-sm text-red-600 py-8 text-center">Could not load: {loadError}</div>;

  return (
    <div className="max-w-7xl mx-auto px-5 sm:px-6 md:pb-24">
      {/* Title block — template name + status + inspector + Back/Unlock. Scrolls
          away on scroll (mirrors Scope / 1099); only the logo bar below pins. */}
      <div className="pt-3 pb-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FitText text={props.templateLabel} className="font-heading font-bold text-gray-900 flex-1 min-w-0" max={22} min={11} copyLink={`/inspection/${props.inspectionRecordId}`} />
              {statusLabel && (
                <span className={`inline-flex items-center shrink-0 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-semibold border whitespace-nowrap ${statusLabel.color}`}>{statusLabel.label}</span>
              )}
            </div>
          </div>
          <div className="shrink-0 flex flex-row items-center gap-1.5">
            <InspectionPager currentId={props.inspectionRecordId} onNavigate={(id) => props.onNavigateTo?.(id)} />
            <button
              type="button"
              onClick={props.onCancel}
              aria-label="Go back"
              className="inline-flex items-center justify-center w-8 h-8 text-gray-700 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg bg-white"
              title="Go back"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
            </button>
            {!props.readOnly && (
              <UnlockButton
                propertyId={props.propertyRecordId}
                address={props.propertyName}
                inspectionId={props.inspectionRecordId}
                lockRing={props.lockRing}
              />
            )}
          </div>
        </div>
        {/* Inspector / report link — full width below the title + controls row
            so it never truncates under the buttons. */}
        <div className="text-xs text-gray-500 mt-0.5 truncate">
          Inspector: {props.inspectorName}
        </div>
        {props.pdfUrl && (
          <a
            href={props.pdfUrl}
            onClick={(e) => { e.preventDefault(); openPdf(props.pdfUrl!, `${props.templateLabel} Report`); }}
            className="mt-1 inline-flex items-center gap-1 text-xs font-heading font-semibold text-brand hover:underline cursor-pointer"
            title="View the generated QC report"
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

      {/* Frozen header — logo + address + bed/bath/sqft + the Pass/Fail tally
          (the subheading). The ONLY thing pinned on scroll (mirrors Scope/1099). */}
      <header className="sticky top-0 z-10 -mx-5 sm:-mx-6 px-5 sm:px-6 bg-white border-b-2 border-brand shadow-sm">
        <div className="max-w-7xl mx-auto py-1.5 relative">
          {/* Pass/Fail tally + save indicator, pinned to the TOP-right (out of
              flow). The address/bed-bath lines get right padding to clear it, but
              the lower status/listing lines run the FULL width beneath it — so the
              listing line (Move-In date) never has to truncate or wrap. */}
          <div className="absolute top-0 right-0 flex flex-col items-end gap-1">
            <div className="flex items-center gap-1.5 text-[11px] font-heading font-bold">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">{totalPass} Pass</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-brand/10 text-brand border border-brand/30">{totalFail} Fail</span>
            </div>
            {!props.readOnly && (
              <div className="text-right"><SaveIndicator phase={saveStatus} /></div>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={props.onCancel} aria-label="Back to inspections" title="Back to inspections" className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/favicon.svg" alt="ResiWalk" className="h-9 w-9 object-contain" />
            </button>
            <div className="min-w-0 flex-1">
              {/* Address + bed/bath clear the pinned Pass/Fail column on the right. */}
              <div className="pr-32">
                <FitText text={props.propertyName} className="font-heading font-semibold text-ink" />
                <div className="text-xs text-gray-500 truncate">
                  {props.bedrooms} Bed / {props.bathrooms} Bath
                  {props.squareFootage != null && props.squareFootage > 0 && (
                    <span> &middot; {props.squareFootage.toLocaleString()} sqft</span>
                  )}
                </div>
              </div>
              {(props.propertyStatus || props.moveInReadyDate) && (
                <div className="text-xs text-gray-500 truncate">
                  {props.propertyStatus}
                  {props.propertyStatus && props.moveInReadyDate && <span> &middot; </span>}
                  {props.moveInReadyDate && <span>MIR: {props.moveInReadyDate}</span>}
                </div>
              )}
              {/* Listing line runs the full width beneath the pinned chips — shows
                  in full, no truncate, no wrap. */}
              {/active|deposit/i.test(props.listingStatus || '') ? (
                <div className={`text-xs whitespace-nowrap ${
                  /active/i.test(props.listingStatus || '') ? 'text-emerald-700' : 'text-amber-600'
                }`}>
                  {props.listingStatus && <span>{props.listingStatus}</span>}
                  {typeof props.listingPrice === 'number' && props.listingPrice > 0 && (
                    <span>{props.listingStatus ? ' · ' : ''}${props.listingPrice.toLocaleString()}</span>
                  )}
                  {!/deposit/i.test(props.listingStatus || '') && props.listingDate && (
                    <span>{(props.listingStatus || (typeof props.listingPrice === 'number' && props.listingPrice > 0)) ? ' · ' : ''}Listed {props.listingDate}</span>
                  )}
                  {/deposit/i.test(props.listingStatus || '') && props.moveInDate && (
                    <span>{(props.listingStatus || (typeof props.listingPrice === 'number' && props.listingPrice > 0)) ? ' · ' : ''}Move-In: {props.moveInDate}</span>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {/* Item/room count + vendor filter (left) · Collapse all (RIGHT). */}
      <div className="flex items-center justify-between flex-wrap gap-2 py-2 mb-3 border-b border-gray-100">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <span className="text-sm font-semibold text-gray-700">
            {hasLines ? `${lines.length} items` : `${sections.length} ${sections.length === 1 ? 'room' : 'rooms'}`}
          </span>
          {assignedVendors.length > 0 && (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-heading text-gray-500 shrink-0">Vendor:</span>
              <ListPicker
                value={activeVendorFilter}
                options={[{ value: 'All', label: 'All Vendors' }, ...assignedVendors.map((v) => ({ value: v, label: v }))]}
                onChange={setVendorFilter}
                ariaLabel="Filter by Assigned Vendor"
                className="text-xs font-heading text-gray-800 flex items-center gap-0.5 hover:text-brand"
              />
              {activeVendorFilter !== 'All' && (
                <button
                  type="button"
                  onClick={() => setVendorFilter('All')}
                  className="text-xs text-brand underline font-heading font-semibold shrink-0"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
        {sections.length > 1 && (
          <button
            type="button"
            onClick={() => setAllCollapsed(!allCollapsed)}
            className="ml-auto inline-flex items-center gap-1 text-xs font-heading text-gray-500 hover:text-gray-800 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                 className={`transition-transform ${allCollapsed ? 'rotate-180' : ''}`}>
              <polyline points="18 15 12 9 6 15" />
            </svg>
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
      </div>

      {props.readOnly && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900 mb-3">
          This inspection is completed and read-only.
        </div>
      )}

      {visibleSections.map((s) => {
        const rvSec = roomVerdict[s.key] || '';
        const secPass = s.lines.filter((l) => l.passFail === 'pass').length + (rvSec === 'pass' ? 1 : 0);
        const secFail = s.lines.filter((l) => l.passFail === 'fail').length + (rvSec === 'fail' ? 1 : 0);
        const after = afterPhotos[s.key] || [];
        const isCollapsed = collapsed.has(s.key);
        // Standalone-QC room verdict drives the "required" highlighting: a Fail
        // needs an After photo + a note.
        const rv = !hasLines ? (roomVerdict[s.key] || '') : '';
        const failNeedsPhoto = rv === 'fail' && after.length === 0;
        const failNeedsNote = rv === 'fail' && !(roomNote[s.key] || '').trim();
        return (
          <section key={s.key} className="mb-4 border border-gray-200 rounded-xl overflow-hidden shadow-md">
            <button
              type="button"
              onClick={() => toggleCollapse(s.key)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200 text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={'text-gray-400 transition-transform ' + (isCollapsed ? '' : 'rotate-90')}>&#9654;</span>
                <h2 className="font-bold text-sm text-gray-900 truncate">{s.displayName}</h2>
                {hasLines && (
                  <span className="text-xs text-gray-400">&middot; {s.lines.length} {s.lines.length === 1 ? 'line' : 'lines'}</span>
                )}
              </div>
              <div className="text-xs font-bold shrink-0">
                <span className="text-emerald-600">{secPass} pass</span>
                <span className="text-gray-300"> &middot; </span>
                <span className="text-brand">{secFail} fail</span>
              </div>
            </button>

            {!isCollapsed && (
              <>
                <div className="px-4 py-3 grid grid-cols-2 gap-3 border-b border-gray-100">
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-2.5 min-w-0">
                    <PhotoStrip
                      label="Before"
                      photoUrls={cameraOpenAnywhere ? [] : s.beforePhotos}
                      size={64}
                      accent="gray"
                      emptyLabel="No before photos on source"
                      collapsed={!!photosCollapsed[s.key]}
                      onToggle={() => setPhotosCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
                      onPhotoClick={(i) => setQcLightbox({ phase: 'before', key: s.key, index: i })}
                    />
                  </div>

                  <div className={'rounded-lg border-2 p-2.5 min-w-0 ' + (failNeedsPhoto ? 'border-brand bg-brand/5' : 'border-teal-300 bg-teal-50/60')}>
                    <PhotoStrip
                      label={failNeedsPhoto
                        ? (<>After <span className="text-brand normal-case font-bold">• Required</span></>)
                        : (after.length === 0 && hasLines) ? 'After • Required' : 'After'}
                      photoUrls={cameraOpenAnywhere ? [] : after}
                      size={64}
                      accent="teal"
                      collapsed={!!photosCollapsed[s.key]}
                      onToggle={() => setPhotosCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
                      onRemove={props.readOnly ? undefined : (u) => removeAfterPhoto(s.key, s.section, s.location, u)}
                      onPhotoClick={(i) => setQcLightbox({ phase: 'after', key: s.key, index: i })}
                    >
                      {!props.readOnly && (
                        <button
                          type="button"
                          onClick={() => setCameraKey(s.key)}
                          className="text-xs font-semibold bg-teal-600 text-white rounded px-2 py-1.5 hover:bg-teal-700 whitespace-nowrap"
                        >Take Photo</button>
                      )}
                    </PhotoStrip>
                    {failNeedsPhoto && (
                      <p className="text-xs text-brand font-heading font-semibold mt-1.5">
                        At least one photo required.
                      </p>
                    )}
                  </div>
                </div>

                {/* Standalone QC: optional per-room Pass/Fail + notes. A Fail
                    requires at least one After photo AND a note (enforced on
                    submit). Pass/blank leaves notes optional. The After-photo
                    requirement is highlighted up in the After block above. */}
                {!hasLines && (
                    <div className="px-4 py-3 border-b border-gray-100">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-heading font-semibold text-gray-500 uppercase tracking-wider">Room Result</span>
                        <span className="text-[11px] text-gray-400">(optional)</span>
                        <div className="ml-auto flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={props.readOnly}
                            onClick={() => setRoomPassFail(s.key, s.section, s.location, 'pass')}
                            className={'px-3 py-1.5 rounded-lg text-xs font-heading font-bold border ' + (rv === 'pass' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50')}
                          >Pass</button>
                          <button
                            type="button"
                            disabled={props.readOnly}
                            onClick={() => setRoomPassFail(s.key, s.section, s.location, 'fail')}
                            className={'px-3 py-1.5 rounded-lg text-xs font-heading font-bold border ' + (rv === 'fail' ? 'bg-brand text-white border-brand' : 'bg-white text-brand border-brand/40 hover:bg-brand/5')}
                          >Fail</button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-heading font-semibold text-gray-500 uppercase tracking-wider">Notes</span>
                        {failNeedsNote && <span className="text-[11px] text-brand font-heading font-bold normal-case">• Required</span>}
                      </div>
                      <textarea
                        value={roomNote[s.key] || ''}
                        disabled={props.readOnly}
                        onChange={(e) => setRoomNoteText(s.key, e.target.value)}
                        onBlur={() => saveRoomNote(s.key, s.section, s.location)}
                        rows={2}
                        placeholder={rv === 'fail' ? 'Required: describe what failed in this room…' : 'Notes for this room (optional)…'}
                        className={'w-full text-sm rounded-lg border-2 px-3 py-2 focus-brand ' + (failNeedsNote ? 'border-brand bg-brand/5' : 'border-gray-300')}
                      />
                    </div>
                )}

                {/* Line items render ONLY when validating a source scope. A
                    standalone QC (no source) has no lines — it's just rooms +
                    after-photos + a final verdict, so the line tables are hidden. */}
                {s.lines.length > 0 && (<>
                {/* Desktop: full table (horizontal scroll if needed) */}
                <div className="overflow-x-auto hidden sm:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200">
                        <th className="px-3 py-2 font-semibold">Category</th>
                        <th className="px-3 py-2 font-semibold">Sub</th>
                        <th className="px-3 py-2 font-semibold">Line Item</th>
                        <th className="px-3 py-2 font-semibold text-center">Qty</th>
                        <th className="px-3 py-2 font-semibold text-center">Unit</th>
                        <th className="px-3 py-2 font-semibold text-center">Vendor</th>
                        <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Vendor $</th>
                        <th className="px-3 py-2 font-semibold text-center">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {s.lines.map((ln) => (
                        <Fragment key={ln.recordId}>
                        <tr className="align-top">
                          <td className="px-3 py-2.5 text-gray-700 whitespace-nowrap">{ln.category}</td>
                          <td className="px-3 py-2.5 text-gray-700 whitespace-nowrap">{ln.subcategory}</td>
                          <td className="px-3 py-2.5 text-gray-900 min-w-[200px]">
                            {ln.description}
                            {ln.scopeNote && (
                              <div className="text-xs text-gray-500 italic mt-1">📝 Scope note: {ln.scopeNote}</div>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-center text-gray-600 tabular-nums whitespace-nowrap">{ln.quantity != null ? formatQty(ln.quantity) : ''}</td>
                          <td className="px-3 py-2.5 text-center text-gray-600">{ln.unit}</td>
                          <td className="px-3 py-2.5 text-center">
                            {ln.vendor && (() => {
                              const ps = vendorPillStyle(ln.vendor);
                              return (
                                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${ps.bg} ${ps.text} ${ps.border || ''}`}>
                                  {ln.vendor}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-900 whitespace-nowrap">{ln.vendorCost != null ? `$${formatMoney(ln.vendorCost)}` : ''}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                disabled={props.readOnly}
                                onClick={() => setLinePassFail(ln, 'pass')}
                                className={
                                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border transition ' +
                                  (ln.passFail === 'pass'
                                    ? 'bg-emerald-600 text-white border-emerald-600'
                                    : 'bg-white text-emerald-600 border-emerald-300 hover:border-emerald-500')
                                }
                                title="Pass"
                              >&#10003;</button>
                              <button
                                type="button"
                                disabled={props.readOnly}
                                onClick={() => setLinePassFail(ln, 'fail')}
                                className={
                                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border transition ' +
                                  (ln.passFail === 'fail'
                                    ? 'bg-brand text-white border-brand'
                                    : 'bg-white text-brand border-brand/40 hover:border-brand')
                                }
                                title="Fail"
                              >&#10007;</button>
                            </div>
                          </td>
                        </tr>
                        {ln.passFail === 'fail' && (
                          <tr>
                            <td colSpan={8} className="px-3 pb-3 pt-0 bg-brand/5">
                              <label className="block text-[11px] font-heading font-semibold text-brand mb-1">Failure note (required) — what failed &amp; how to fix it</label>
                              <textarea
                                value={ln.qcFailureNote || ''}
                                disabled={props.readOnly}
                                onChange={(e) => updateFailureNote(ln.recordId, e.target.value)}
                                onBlur={(e) => saveFailureNote(ln.recordId, e.target.value.trim())}
                                rows={2}
                                placeholder="e.g. Paint touch-up missed the north wall; re-coat and feather edges."
                                className="focus-brand w-full border border-brand/40 rounded-lg p-2 text-sm bg-white"
                              />
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: stacked cards.
                    Cat · Sub · Short Desc  /  Subtext  /  Vendor · Qty Unit · Price
                    with pass/fail on the right. */}
                <div className="sm:hidden divide-y divide-gray-100 px-1">
                  {s.lines.map((ln) => {
                    const ps = ln.vendor ? vendorPillStyle(ln.vendor) : null;
                    return (
                      <div key={ln.recordId} className="py-3 px-2">
                       <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          {/* Line 1: Category · Sub · Short description */}
                          <div className="text-sm font-semibold text-gray-900 leading-snug">
                            <span className="text-gray-500 font-normal">
                              {ln.category}{ln.subcategory ? ` · ${ln.subcategory}` : ''} ·{' '}
                            </span>
                            {ln.description}
                          </div>
                          {/* Line 2: Subtext (only if present + different) */}
                          {ln.subtext && (
                            <div className="text-xs text-gray-500 leading-snug">{ln.subtext}</div>
                          )}
                          {/* Line 3: Vendor · Qty Unit · Price */}
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600 pt-0.5">
                            {ps && (
                              <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${ps.bg} ${ps.text} ${ps.border || ''}`}>
                                {ln.vendor}
                              </span>
                            )}
                            {ln.unit && <span>{ln.quantity != null ? `${formatQty(ln.quantity)} ` : ''}{ln.unit}</span>}
                            {ln.vendorCost != null && (<><span>·</span><span className="text-gray-800 font-semibold">${formatMoney(ln.vendorCost)}</span></>)}
                          </div>
                        </div>
                        {/* Pass / fail */}
                        <div className="flex items-center gap-2 shrink-0 pt-0.5">
                          <button
                            type="button"
                            disabled={props.readOnly}
                            onClick={() => setLinePassFail(ln, 'pass')}
                            className={
                              'w-10 h-9 rounded-lg flex items-center justify-center text-sm font-bold border transition ' +
                              (ln.passFail === 'pass'
                                ? 'bg-emerald-600 text-white border-emerald-600'
                                : 'bg-white text-emerald-600 border-emerald-300')
                            }
                            aria-label="Pass"
                          >&#10003;</button>
                          <button
                            type="button"
                            disabled={props.readOnly}
                            onClick={() => setLinePassFail(ln, 'fail')}
                            className={
                              'w-10 h-9 rounded-lg flex items-center justify-center text-sm font-bold border transition ' +
                              (ln.passFail === 'fail'
                                ? 'bg-brand text-white border-brand'
                                : 'bg-white text-brand border-brand/40')
                            }
                            aria-label="Fail"
                          >&#10007;</button>
                        </div>
                       </div>
                       {/* Scope note (read-only reference: what to look for). */}
                       {ln.scopeNote && (
                         <div className="text-xs text-gray-500 italic mt-2 border-t border-gray-100 pt-2">📝 Scope note: {ln.scopeNote}</div>
                       )}
                       {/* Required failure note when failed. */}
                       {ln.passFail === 'fail' && (
                         <div className="mt-2">
                           <label className="block text-[11px] font-heading font-semibold text-brand mb-1">Failure note (required) — what failed &amp; how to fix it</label>
                           <textarea
                             value={ln.qcFailureNote || ''}
                             disabled={props.readOnly}
                             onChange={(e) => updateFailureNote(ln.recordId, e.target.value)}
                             onBlur={(e) => saveFailureNote(ln.recordId, e.target.value.trim())}
                             rows={2}
                             placeholder="e.g. Paint touch-up missed the north wall; re-coat and feather edges."
                             className="focus-brand w-full border border-brand/40 rounded-lg p-2 text-sm bg-white"
                           />
                         </div>
                       )}
                      </div>
                    );
                  })}
                </div>
                </>)}
              </>
            )}
          </section>
        );
      })}

      {lines.length === 0 && (
        <div className="text-sm text-gray-500 py-8 text-center border border-gray-200 rounded-xl">
          No line items were copied from the source inspection.
        </div>
      )}

      {!props.readOnly && (
        <div className="border-2 border-gray-200 rounded-xl p-4 mb-4 mt-4">
          <div className="text-sm font-bold text-gray-900 mb-2">Overall Inspection Result</div>
          <div className="flex items-center gap-3 mb-2">
            <button
              type="button"
              onClick={() => setVerdict('pass')}
              className={
                'flex-1 py-3 rounded-lg font-bold border-2 transition ' +
                (verdict === 'pass' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-600 border-emerald-300 hover:border-emerald-500')
              }
            >&#10003; Pass</button>
            <button
              type="button"
              onClick={() => setVerdict('fail')}
              className={
                'flex-1 py-3 rounded-lg font-bold border-2 transition ' +
                (verdict === 'fail' ? 'bg-brand text-white border-brand' : 'bg-white text-brand border-brand/40 hover:border-brand')
              }
            >&#10007; Fail</button>
          </div>

          {/* Required overall failure comment (Fail only) — printed on the PDF. */}
          {verdict === 'fail' && (
            <div className="mb-2">
              <label className="block text-[11px] font-heading font-semibold text-brand mb-1">Overall failure comment (required) — why the re-inspect failed</label>
              <textarea
                value={overallNote}
                onChange={(e) => setOverallNote(e.target.value)}
                rows={3}
                placeholder="Summarize what failed overall and what's needed to pass the re-inspect."
                className="focus-brand w-full border border-brand/40 rounded-lg p-2 text-sm bg-white"
              />
            </div>
          )}

          {(!allMarked || !allSectionsHaveAfter || !standaloneFailRoomsOk || !verdict || (verdict === 'fail' && !overallNote.trim())) && (
            <ul className="text-xs text-amber-700 list-disc pl-5 space-y-0.5">
              {!allMarked && <li>Mark every line item Pass or Fail.</li>}
              {!allSectionsHaveAfter && <li>Add at least one After Photo to every section.</li>}
              {!standaloneFailRoomsOk && <li>Each room marked Fail needs an After photo and a note.</li>}
              {!verdict && <li>Choose an overall Pass/Fail verdict.</li>}
              {verdict === 'fail' && !overallNote.trim() && <li>Add an overall failure comment.</li>}
            </ul>
          )}
        </div>
      )}

      {/* Maintenance ticket — NEW items only (not on the original scope). Sits at
          the very bottom, after the verdict. The callout is deliberately blunt:
          this is NOT the place to re-report failed checklist items (those are
          already tracked on the lines above) — it's ONLY for additional work
          discovered on re-inspect that was never part of the original scope. */}
      {!props.readOnly && (
        <div className="border-2 border-amber-300 rounded-xl p-4 mb-4 bg-amber-50">
          <div className="font-heading font-extrabold text-ink text-sm mb-1">⚠️ New Items Only — Maintenance Ticket</div>
          <div className="text-[13px] text-amber-900 font-bold leading-snug mb-3">
            Use this ONLY for new issues found during this re-inspect that were NOT on the original scope.
          </div>
          <div className="font-heading font-semibold text-ink text-sm mb-2">Submit a maintenance ticket for new items?</div>
          <div className="flex gap-2">
            {(['Yes', 'No'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => { setMaintTicketWanted(opt); if (opt === 'No') setMaintTicketDescription(''); }}
                className={`px-4 py-2 rounded-lg text-sm font-heading font-semibold border transition-colors ${
                  maintTicketWanted === opt ? 'bg-brand text-white border-brand' : 'bg-white text-ink border-gray-300 hover:border-brand/50'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
          {maintTicketWanted === 'Yes' && (
            <div className="mt-3">
              <label className="block text-sm font-heading font-semibold text-ink mb-1.5">
                Ticket description <span className="text-brand">*</span>
              </label>
              <textarea
                value={maintTicketDescription}
                onChange={(e) => setMaintTicketDescription(e.target.value)}
                rows={3}
                placeholder="Describe the NEW item(s) found that weren't on the original scope. This becomes the maintenance ticket."
                className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base bg-white"
              />
              <div className="text-xs text-gray-500 mt-1">Required before you can submit.</div>
            </div>
          )}
        </div>
      )}

      {/* Completed / read-only: show the recorded overall verdict (the editable
          selector above is hidden once submitted, so without this the inspector
          couldn't see whether the re-inspect passed or failed). */}
      {props.readOnly && verdict && (
        <div className="border-2 border-gray-200 rounded-xl p-4 mb-4 mt-4">
          <div className="text-sm font-bold text-gray-900 mb-2">Overall Inspection Result</div>
          <span className={
            'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg font-bold border-2 ' +
            (verdict === 'pass' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-brand text-white border-brand')
          }>
            {verdict === 'pass' ? '✓ Pass' : '✗ Fail'}
          </span>
          {/* Overall failure comment (Fail only) — why the re-inspect failed. */}
          {verdict === 'fail' && overallNote.trim() && (
            <div className="mt-3">
              <div className="text-[11px] font-heading font-semibold text-brand mb-1">Overall failure comment</div>
              <div className="text-sm text-gray-800 whitespace-pre-wrap border border-brand/30 bg-brand/5 rounded-lg p-2.5">{overallNote}</div>
            </div>
          )}
        </div>
      )}

      {/* Completed / read-only: the recorded maintenance-ticket selection. */}
      {props.readOnly && (maintTicketWanted === 'Yes' || maintTicketWanted === 'No') && (
        <div className="border-2 border-gray-200 rounded-xl p-4 mb-4">
          <div className="text-sm font-bold text-gray-900 mb-2">Maintenance Ticket — New Items</div>
          <div className="text-sm text-gray-800">{maintTicketWanted === 'Yes' ? 'Yes — ticket requested for new items' : 'No new items'}</div>
          {maintTicketWanted === 'Yes' && maintTicketDescription.trim() && (
            <div className="mt-2 text-sm text-gray-800 whitespace-pre-wrap border border-gray-200 bg-gray-50 rounded-lg p-2.5">{maintTicketDescription}</div>
          )}
        </div>
      )}

      {/* Spacer so the fixed footer doesn't cover the last content (grows by the
          app-wide sync footer's height when it's showing). */}
      {!props.readOnly && <div style={{ height: 'calc(5rem + var(--sync-footer-h, 0px))' }} />}

      {/* Floating footer — mirrors the Scope Rate Card: Save & Close on the LEFT
          (with the live save-status chip), Submit on the right. No Cancel button.
          Shown for editable inspections. */}
      {!props.readOnly && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t-2 border-gray-200 shadow-[0_-4px_10px_rgba(0,0,0,0.05)] z-30" style={{ bottom: 'var(--sync-footer-h, 0px)', transition: 'bottom .25s ease' }}>
          <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={props.onCancel}
                className="px-2.5 sm:px-4 py-2 text-xs sm:text-sm border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-600 hover:text-white hover:border-emerald-600 active:bg-emerald-700 active:border-emerald-700 transition-colors whitespace-nowrap"
              >
                Save &amp; Close
              </button>
              <span className="hidden sm:inline-flex"><SaveStatusChip status={saveStatus} /></span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleSubmit}
                /* Only disable while actively submitting. The completeness checks
                   (all marked, every section has an After photo, fail rooms have a
                   note, a verdict is set) are ALL re-validated in handleSubmit and
                   show a specific reason — disabling the button for them instead
                   made the tap do nothing with no explanation (the "nothing happens
                   when I hit submit" report, which a lost After photo triggered). */
                disabled={submitting}
                className="px-3 sm:px-5 py-2 text-xs sm:text-sm bg-brand text-white font-semibold rounded hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {submitting ? 'Submitting...' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {cameraKey != null && (
        <CameraCapture
          isOpen={true}
          addressSnapshot={props.propertyName}
          propertyRecordId={props.propertyRecordId}
          onClose={() => setCameraKey(null)}
          uploadPhoto={uploadHelper}
          uploadVideoEntry={(videoFile, posterFile) => uploadVideoEntryOrQueue(videoFile, posterFile, props.inspectionRecordId, cameraKey || '')}
          rooms={sections.map((s) => {
            const roomPhotos = afterPhotos[s.key] || [];
            const count = roomPhotos.length;
            return {
              id: s.key,
              name: s.displayName,
              photoCount: count,
              needsPhotos: count === 0, // QC requires an after-photo per section
              photos: roomPhotos,
            };
          })}
          currentRoomId={cameraKey}
          tagLines={(sections.find((s) => s.key === cameraKey)?.lines || [])
            .map((l) => ({ externalId: l.recordId, label: l.description || l.lineItemCode }))}
          onTagPhotoToLine={tagCameraPhotoToLineQc}
          onRoomChange={(leavingKey, capturedUrls, enteringKey) => {
            if (capturedUrls.length > 0) {
              const sec = sections.find((s) => s.key === leavingKey);
              if (sec) addAfterPhotos(sec.key, sec.section, sec.location, capturedUrls);
            }
            setCameraKey(enteringKey);
          }}
          onComplete={(urls) => {
            const sec = sections.find((s) => s.key === cameraKey);
            if (sec) addAfterPhotos(sec.key, sec.section, sec.location, urls);
            setCameraKey(null);
          }}
        />
      )}

      {result && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5">
            <div className={'text-lg font-bold mb-1 ' + (result.verdict === 'pass' ? 'text-emerald-700' : 'text-brand')}>
              {result.verdict === 'pass' ? 'QC Passed' : 'QC Failed'}
            </div>
            <div className="text-sm text-gray-600 mb-4">{result.passCount} passed &middot; {result.failCount} failed</div>
            {result.resultSync && !result.resultSync.verdictSynced && (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3">
                Heads up: the report saved, but the overall verdict couldn’t be written to the inspection
                record (the QC result fields aren’t set up in HubSpot yet). Ask an admin to provision them.
              </div>
            )}
            {result.ticket && (
              <div className={`text-xs rounded-md px-3 py-2 mb-3 border ${result.ticket.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900'}`}>
                {result.ticket.ok ? (
                  <>
                    <span className="font-heading font-bold">Maintenance ticket created for the new items.</span>
                    {result.ticket.url && (
                      <a href={result.ticket.url} target="_blank" rel="noreferrer" className="text-brand underline block mt-1">View ticket in Maintenance system</a>
                    )}
                  </>
                ) : (
                  <><span className="font-heading font-bold">Maintenance ticket not created.</span> {result.ticket.error || 'Reason unknown.'} The QC is still completed; raise it manually if needed.</>
                )}
              </div>
            )}
            <a
              href={result.pdf.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center py-2.5 rounded-lg font-semibold text-brand border border-brand/40 hover:bg-brand/5 mb-2"
            >Download QC Report (PDF)</a>
            <button
              type="button"
              onClick={() => { setResult(null); props.onSubmit(); }}
              className="w-full py-2.5 rounded-lg font-semibold text-white bg-gray-800 hover:bg-gray-900"
            >Done</button>
          </div>
        </div>
      )}

      {/* Photo viewer (swipe / markup / delete / tag-to-line / video) */}
      {qcLightbox && (() => {
        const isAfter = qcLightbox.phase === 'after';
        const photosByGroup = Object.fromEntries(
          sections.map((s) => [s.key, (isAfter ? (afterPhotos[s.key] || []) : s.beforePhotos)])
        );
        if ((photosByGroup[qcLightbox.key] || []).length === 0) return null;
        const groups = sections.map((s) => ({ id: s.key, name: s.displayName }));
        const secOf = (gid: string) => sections.find((s) => s.key === gid);
        return (
          <PhotoLightbox
            groups={groups}
            photosByGroup={photosByGroup}
            initialGroupId={qcLightbox.key}
            initialIndex={qcLightbox.index}
            // Before photos are the read-only source; After is editable.
            readOnly={!isAfter || props.readOnly}
            onClose={() => setQcLightbox(null)}
            onDelete={(gid, i) => {
              const sec = secOf(gid); if (!sec) return;
              const url = (afterPhotos[gid] || [])[i];
              if (url) removeAfterPhoto(sec.key, sec.section, sec.location, url);
            }}
            onReplace={(gid, i, file) => {
              const sec = secOf(gid); if (!sec) return;
              replaceAfterPhoto(sec.key, sec.section, sec.location, i, file);
            }}
            tagLinesByGroup={isAfter && !props.readOnly
              ? Object.fromEntries(sections.map((s) => [
                  s.key,
                  s.lines.map((l) => ({ externalId: l.recordId, label: l.description || l.lineItemCode })),
                ]))
              : undefined}
            onTagToLine={isAfter && !props.readOnly
              ? (gid, i, lineRecordId) => { if (secOf(gid)) tagAfterPhotoToLine(gid, i, lineRecordId); }
              : undefined}
            onUntagFromLine={isAfter && !props.readOnly
              ? (gid, i, lineRecordId) => { if (secOf(gid)) untagAfterPhotoFromLine(gid, i, lineRecordId); }
              : undefined}
            currentTagsFor={isAfter ? (gid, i) => currentTagsForAfter(gid, i) : undefined}
          />
        );
      })()}
    </div>
  );
}

/** Small live save-status indicator, mirrors the Scope Rate Card footer. */
function SaveStatusChip({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (status === 'idle') return null;
  const map = {
    saving: { text: 'Saving…', cls: 'text-gray-500' },
    saved: { text: 'All changes saved', cls: 'text-emerald-600' },
    error: { text: 'Save failed — retry', cls: 'text-red-600' },
  } as const;
  const m = map[status];
  return <span className={`text-xs font-heading font-semibold ${m.cls}`}>{m.text}</span>;
}
