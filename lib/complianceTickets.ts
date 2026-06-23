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
 * associated to the inspection's Property (field OR association), and gets a Note
 * carrying the details + a link to the inspection, with ONLY that issue's own
 * photo(s) attached (e.g. the Water ticket gets the water-meter photo). The meter
 * number is shown bold + red in the note. Best-effort: never blocks submission.
 */
import { parseFcAnswers } from '@/lib/finalChecklist';
import {
  createComplianceTicket, createTicketNoteWithAttachments, uploadPhotoUrlForAttachment,
  resolveInspectionPropertyId, getComplianceTicketsStamp, stampComplianceTicketsCreated,
  type SavedAnswer,
} from '@/lib/hubspot';

interface ComplianceIssue {
  key: 'electric' | 'water' | 'gas' | 'trash';
  reason: string;          // human label used in the ticket subject
  meterNumber?: string;    // the OFF utility's captured meter number, if any
  photoUrls: string[];     // ONLY this issue's own photos (e.g. its meter photo)
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

/** Compute which compliance issues a 1099's Final Checklist answers represent,
 *  capturing each issue's own meter number + photo(s). */
export function complianceIssuesFromAnswers(answers: SavedAnswer[]): ComplianceIssue[] {
  const fcBlob = findFcBlob(answers);
  if (!fcBlob) return [];
  const fc = parseFcAnswers(fcBlob.note);
  const valOf = (k: string) => String(fc[k]?.value ?? '').trim().toLowerCase();
  const noteOf = (k: string) => { const n = String(fc[k]?.note ?? '').trim(); return n || undefined; };
  const photosOf = (k: string) => (fc[k]?.photoUrls || []).filter(Boolean);

  const issues: ComplianceIssue[] = [];
  if (valOf('fc_electric') === 'off') issues.push({ key: 'electric', reason: 'Electric Off', meterNumber: noteOf('fc_electric'), photoUrls: photosOf('fc_electric') });
  if (valOf('fc_water') === 'off') issues.push({ key: 'water', reason: 'Water Off', meterNumber: noteOf('fc_water'), photoUrls: photosOf('fc_water') });
  if (valOf('fc_gas') === 'off') issues.push({ key: 'gas', reason: 'Gas Off', meterNumber: noteOf('fc_gas'), photoUrls: photosOf('fc_gas') });
  if (valOf('fc_trash_bins') === 'missing') issues.push({ key: 'trash', reason: 'Trash Bins Missing', photoUrls: photosOf('fc_trash_bins') });
  return issues;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/**
 * Create the compliance tickets for a completed 1099. Each issue is independent —
 * one failing create doesn't stop the rest. Each ticket gets ONLY its own photos.
 */
export async function createComplianceTicketsOnSubmit(
  inspection: ComplianceInspectionRef,
  answers: SavedAnswer[],
  opts?: { baseUrl?: string },
): Promise<{ created: string[]; failed: string[]; gated: boolean }> {
  const created: string[] = [];
  const failed: string[] = [];

  // GATE: compliance tickets are created ONCE per inspection. If this inspection
  // was already processed (stamp present), re-entering / re-submitting and
  // changing answers must NOT create the tickets again.
  const stamp = await getComplianceTicketsStamp(inspection.recordId);
  if (stamp) {
    console.log(`[compliance-tickets] ${inspection.recordId}: already processed (${stamp}) — gate active, skipping`);
    return { created, failed, gated: true };
  }

  const issues = complianceIssuesFromAnswers(answers);
  if (issues.length === 0) {
    // First submit, no compliance issues — stamp anyway so a later re-entry that
    // flips a utility OFF doesn't open a ticket on an already-submitted inspection.
    await stampComplianceTicketsCreated(inspection.recordId);
    return { created, failed, gated: false };
  }

  const address = (inspection.propertyAddressSnapshot || '').trim();
  const base = (opts?.baseUrl || 'https://resiwalk.com').replace(/\/+$/, '');
  const inspectionUrl = `${base}/inspection/${inspection.recordId}`;

  // Resolve the property once: the explicit field, else the inspection→property
  // association (so tickets associate even when property_id_ref is blank).
  const propertyId = await resolveInspectionPropertyId(inspection.recordId, inspection.propertyRecordId);
  if (!propertyId) console.warn(`[compliance-tickets] ${inspection.recordId}: no property id (field or association) — tickets will not be property-linked`);

  // Cache photo re-uploads by URL so a shared photo isn't uploaded twice.
  const fileIdByUrl = new Map<string, string | null>();
  const uploadOnce = async (url: string): Promise<string | null> => {
    if (fileIdByUrl.has(url)) return fileIdByUrl.get(url)!;
    const id = await uploadPhotoUrlForAttachment(url);
    fileIdByUrl.set(url, id);
    return id;
  };

  for (const issue of issues) {
    const subject = `1099-Inspection - ${issue.reason}${address ? ' - ' + address : ''}`;
    // Plain-text ticket description.
    const description = [
      'Auto-created from a completed 1099 Leasing Agent Inspection.',
      address ? `Property: ${address}` : '',
      inspection.inspectorName ? `Inspector: ${inspection.inspectorName}` : '',
      issue.meterNumber ? `Meter Number: ${issue.meterNumber}` : '',
      `Inspection: ${inspectionUrl}`,
    ].filter(Boolean).join('\n');

    try {
      const r = await createComplianceTicket({ subject, content: description, propertyRecordId: propertyId });

      let noteNote = '';
      if (!r.deduped) {
        // This issue's own photos only (e.g. the water-meter photo on the Water ticket).
        const ids: string[] = [];
        for (const url of issue.photoUrls) { const id = await uploadOnce(url); if (id) ids.push(id); }

        // HTML note body — meter number rendered BOLD + RED.
        const noteBody = [
          'Auto-created from a completed 1099 Leasing Agent Inspection.',
          address ? `Property: ${escHtml(address)}` : '',
          inspection.inspectorName ? `Inspector: ${escHtml(inspection.inspectorName)}` : '',
          issue.meterNumber ? `<strong style="color:#e00000;">Meter Number: ${escHtml(issue.meterNumber)}</strong>` : '',
          `Inspection: <a href="${escHtml(inspectionUrl)}">${escHtml(inspectionUrl)}</a>`,
        ].filter(Boolean).join('<br>');

        const noteId = await createTicketNoteWithAttachments(r.ticketId, noteBody, ids);
        noteNote = noteId ? `, note #${noteId} (${ids.length}/${issue.photoUrls.length} photo${issue.photoUrls.length === 1 ? '' : 's'})` : ', note FAILED';
      }
      created.push(`${issue.reason} → ticket #${r.ticketId}${r.deduped ? ' (existing — deduped)' : ''}${r.associatedProperty ? '' : ' (property NOT associated)'}${noteNote}`);
    } catch (e) {
      console.warn(`[compliance-tickets] create failed for "${issue.reason}" on inspection ${inspection.recordId}:`, e);
      failed.push(issue.reason);
    }
  }

  // Stamp the inspection so future submits short-circuit (gate). Only when every
  // issue was handled — if one failed, leave it unstamped so a re-submit can
  // retry it (the subject dedupe still prevents duplicating the ones that did
  // succeed).
  if (failed.length === 0) await stampComplianceTicketsCreated(inspection.recordId);

  return { created, failed, gated: false };
}
