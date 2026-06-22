/**
 * lib/complianceTickets.ts — raise HubSpot Compliance Issue tickets from a
 * completed 1099 Leasing Agent Inspection.
 *
 * Trigger (on submit): one SEPARATE ticket per issue when a utility is OFF or
 * the trash bins are MISSING, read from the Final Checklist Utilities answers
 * (the fc__all blob: fc_electric / fc_water / fc_gas / fc_trash_bins):
 *   - Electric  = Off       → "1099-Inspection - Electric Off - {address}"
 *   - Water     = Off       → "1099-Inspection - Water Off - {address}"
 *   - Gas       = Off       → "1099-Inspection - Gas Off - {address}"
 *   - Trash Bins = Missing  → "1099-Inspection - Trash Bins Missing - {address}"
 *
 * Each ticket lands in the Compliance Issues pipeline at the NEW stage, is
 * associated to the inspection's Property, and gets a Note carrying the same
 * details as the description PLUS a link to the inspection, with the inspection's
 * photos attached (so they show on the ticket's Attachments card). Best-effort:
 * never blocks the inspection submission.
 */
import { parseFcAnswers } from '@/lib/finalChecklist';
import {
  createComplianceTicket, createTicketNoteWithAttachments, uploadPhotoUrlForAttachment,
  type SavedAnswer,
} from '@/lib/hubspot';

interface ComplianceIssue {
  key: 'electric' | 'water' | 'gas' | 'trash';
  reason: string;          // human label used in the ticket subject
  meterNumber?: string;    // the OFF utility's captured meter number, if any
}

export interface ComplianceInspectionRef {
  recordId: string;
  propertyAddressSnapshot: string;
  propertyRecordId: string | null;
  inspectorName?: string;
}

/** The Final Checklist answer blob (one qa record carrying the JSON Utilities map). */
function findFcBlob(answers: SavedAnswer[]): SavedAnswer | undefined {
  return answers.find(
    (a) => a.questionIdExternal === 'fc__all' || String(a.answerIdExternal || '').startsWith('FINALCHECKLIST-'),
  );
}

/** Compute which compliance issues a 1099's Final Checklist answers represent. */
export function complianceIssuesFromAnswers(answers: SavedAnswer[]): ComplianceIssue[] {
  const fcBlob = findFcBlob(answers);
  if (!fcBlob) return [];
  const fc = parseFcAnswers(fcBlob.note);
  const valOf = (k: string) => String(fc[k]?.value ?? '').trim().toLowerCase();
  const noteOf = (k: string) => {
    const n = String(fc[k]?.note ?? '').trim();
    return n || undefined;
  };

  const issues: ComplianceIssue[] = [];
  if (valOf('fc_electric') === 'off') issues.push({ key: 'electric', reason: 'Electric Off', meterNumber: noteOf('fc_electric') });
  if (valOf('fc_water') === 'off') issues.push({ key: 'water', reason: 'Water Off', meterNumber: noteOf('fc_water') });
  if (valOf('fc_gas') === 'off') issues.push({ key: 'gas', reason: 'Gas Off', meterNumber: noteOf('fc_gas') });
  if (valOf('fc_trash_bins') === 'missing') issues.push({ key: 'trash', reason: 'Trash Bins Missing' });
  return issues;
}

/** Collect every distinct photo URL captured on the inspection (regular answers
 *  + the Final Checklist per-question photos), preserving order. */
function collectInspectionPhotoUrls(answers: SavedAnswer[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (u?: string | null) => { const v = (u || '').trim(); if (v && !seen.has(v)) { seen.add(v); urls.push(v); } };
  for (const a of answers) {
    for (const u of (a.photoUrls || [])) add(u);
    for (const u of ((a as any).afterPhotoUrls || [])) add(u);
  }
  const fcBlob = findFcBlob(answers);
  if (fcBlob) {
    try {
      const fc = parseFcAnswers(fcBlob.note);
      for (const st of Object.values(fc)) {
        for (const u of (st.photoUrls || [])) add(u);
        for (const arr of Object.values(st.stickerPhotos || {})) for (const u of (arr || [])) add(u);
      }
    } catch { /* malformed blob → no FC photos */ }
  }
  return urls;
}

/**
 * Create the compliance tickets for a completed 1099. Returns a summary for
 * logging. Each issue is independent — one failing create doesn't stop the rest.
 * The inspection's photos are uploaded ONCE and reused across every ticket's note.
 */
export async function createComplianceTicketsOnSubmit(
  inspection: ComplianceInspectionRef,
  answers: SavedAnswer[],
  opts?: { baseUrl?: string },
): Promise<{ created: string[]; failed: string[] }> {
  const issues = complianceIssuesFromAnswers(answers);
  const created: string[] = [];
  const failed: string[] = [];
  if (issues.length === 0) return { created, failed };

  const address = (inspection.propertyAddressSnapshot || '').trim();
  const base = (opts?.baseUrl || 'https://resiwalk.com').replace(/\/+$/, '');
  const inspectionUrl = `${base}/inspection/${inspection.recordId}`;

  // Upload the inspection's photos ONCE to get File IDs, then reuse those ids on
  // every ticket's note (so the photos land on each ticket's Attachments card).
  const photoUrls = collectInspectionPhotoUrls(answers);
  const fileIds: string[] = [];
  for (const url of photoUrls) {
    const id = await uploadPhotoUrlForAttachment(url);
    if (id) fileIds.push(id);
  }
  if (photoUrls.length && fileIds.length < photoUrls.length) {
    console.warn(`[compliance-tickets] ${inspection.recordId}: attached ${fileIds.length}/${photoUrls.length} photos (some uploads failed)`);
  }

  for (const issue of issues) {
    const subject = `1099-Inspection - ${issue.reason}${address ? ' - ' + address : ''}`;
    const body = [
      'Auto-created from a completed 1099 Leasing Agent Inspection.',
      address ? `Property: ${address}` : '',
      inspection.inspectorName ? `Inspector: ${inspection.inspectorName}` : '',
      issue.meterNumber ? `Meter Number: ${issue.meterNumber}` : '',
      `Inspection: ${inspectionUrl}`,
    ].filter(Boolean).join('\n');
    try {
      const r = await createComplianceTicket({ subject, content: body, propertyRecordId: inspection.propertyRecordId });
      // Add the note (same info + inspection link) carrying the photo attachments,
      // unless this was a dedupe hit (the note already exists from the first run).
      let noteNote = '';
      if (!r.deduped) {
        const noteBody = body.replace(/\n/g, '<br>');
        const noteId = await createTicketNoteWithAttachments(r.ticketId, noteBody, fileIds);
        noteNote = noteId ? `, note #${noteId} (${fileIds.length} photo${fileIds.length === 1 ? '' : 's'})` : ', note FAILED';
      }
      created.push(`${issue.reason} → ticket #${r.ticketId}${r.deduped ? ' (existing — deduped)' : ''}${r.associatedProperty ? '' : ' (property NOT associated)'}${noteNote}`);
    } catch (e) {
      console.warn(`[compliance-tickets] create failed for "${issue.reason}" on inspection ${inspection.recordId}:`, e);
      failed.push(issue.reason);
    }
  }
  return { created, failed };
}
