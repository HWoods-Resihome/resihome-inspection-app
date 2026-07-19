/**
 * ResiWalk - Services — per-work-order NOTES THREAD (vendor ↔ internal).
 *
 * Back-and-forth comments on a Service Work Order: either side posts in-app, the
 * other side is emailed the note, and a plain email REPLY is ingested back into
 * the thread by the notes-inbox cron (the subject carries a [SVC#<id>] token).
 *
 * Storage mirrors the audit log: one append-only Vercel blob per note under
 * svc-notes/<serviceId>/<sortable-ts>-<rand>.json — no size caps, no
 * read-modify-write races. Best-effort: a note write must never take down the
 * posting flow (the API surfaces failures to the user, but reads fail soft).
 */
import { put, list } from '@vercel/blob';

export interface ServiceNote {
  id: string;                    // blob-derived, stable
  serviceId: string;
  at: string;                    // ISO timestamp
  byEmail: string;
  byName: string;
  role: 'vendor' | 'internal';
  source: 'app' | 'email';       // posted in-app vs ingested from an email reply
  text: string;
}

const MAX_NOTE_CHARS = 4000;

export function clipNoteText(s: unknown): string {
  return String(s ?? '').trim().slice(0, MAX_NOTE_CHARS);
}

/** Append one note. Throws on storage failure so the poster sees it. */
export async function addServiceNote(n: {
  serviceId: string;
  byEmail: string;
  byName: string;
  role: 'vendor' | 'internal';
  source: 'app' | 'email';
  text: string;
}): Promise<ServiceNote> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Note storage is not configured (BLOB_READ_WRITE_TOKEN).');
  const name = `${Date.now().toString().padStart(15, '0')}-${Math.random().toString(36).slice(2, 7)}`;
  const note: ServiceNote = {
    id: name,
    serviceId: String(n.serviceId),
    at: new Date().toISOString(),
    byEmail: String(n.byEmail || '').trim().toLowerCase().slice(0, 200),
    byName: String(n.byName || n.byEmail || '').trim().slice(0, 200),
    role: n.role,
    source: n.source,
    text: clipNoteText(n.text),
  };
  if (!note.text) throw new Error('Note text is required.');
  await put(`svc-notes/${note.serviceId}/${name}.json`, JSON.stringify(note),
    { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
  return note;
}

/** A service's notes, OLDEST first (chronological thread order). Fails soft. */
export async function readServiceNotes(serviceId: string): Promise<ServiceNote[]> {
  const out: ServiceNote[] = [];
  if (!process.env.BLOB_READ_WRITE_TOKEN || !serviceId) return out;
  try {
    const { blobs } = await list({ prefix: `svc-notes/${serviceId}/` });
    const notes = await Promise.all(blobs.map((b) => fetch(b.url).then((r) => r.json()).catch(() => null)));
    for (const n of notes) if (n?.text) out.push(n as ServiceNote);
  } catch (e: any) {
    console.warn('[svc-notes] read failed:', String(e?.message || e).slice(0, 120));
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}
