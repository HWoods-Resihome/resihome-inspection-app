/**
 * App-admin access control.
 *
 * Unifies "who is an admin" into one DYNAMIC list (stored on the HubSpot Agent
 * record, see lib/hubspot readAppAdmins/writeAppAdmins) plus a hard-coded SEED
 * list that can never be removed — so the system can't lock itself out.
 *
 * App-admin grants: AI Knowledge curation, the form/template builder, and admin
 * management (adding/removing other admins). The finalize self-approval bypass
 * stays its OWN list (lib/finalizeAccess) — it's security-sensitive and we don't
 * want adding a form-builder admin to silently also grant finalize power.
 *
 * The dynamic list requires an async HubSpot read, so admin gating in API routes
 * is async (isAppAdmin). The seed list is also exposed synchronously for places
 * that only need the bootstrap check.
 */
import { AI_KNOWLEDGE_ADMINS } from '@/lib/aiKnowledgeAccess';
import { readAppAdmins, writeAppAdmins, type AppAdminRecord } from '@/lib/hubspot';

// Permanent bootstrap admins (always admin; cannot be removed via the UI).
export const SEED_ADMINS: string[] = Array.from(new Set(AI_KNOWLEDGE_ADMINS.map((e) => e.toLowerCase())));

export function isSeedAdmin(email: string | null | undefined): boolean {
  return SEED_ADMINS.includes((email || '').trim().toLowerCase());
}

// Short cache so admin gating doesn't hit HubSpot on every request.
let _cache: { emails: Set<string>; at: number } | null = null;
const TTL_MS = 60_000;

async function dynamicAdminEmails(): Promise<Set<string>> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.emails;
  let emails = new Set<string>();
  try {
    const list = await readAppAdmins();
    emails = new Set(list.map((a) => a.email.trim().toLowerCase()));
  } catch { /* fall back to seed only */ }
  _cache = { emails, at: Date.now() };
  return emails;
}

function bustCache() { _cache = null; }

/** Is this user an app admin (seed OR dynamic list)? Async — reads the store. */
export async function isAppAdmin(email: string | null | undefined): Promise<boolean> {
  const e = (email || '').trim().toLowerCase();
  if (!e) return false;
  if (SEED_ADMINS.includes(e)) return true;
  return (await dynamicAdminEmails()).has(e);
}

export interface AdminListEntry {
  email: string;
  seed: boolean;            // built-in (cannot be removed)
  addedByEmail?: string;
  addedAt?: number;
}

/** The full admin roster (seed first, then dynamic), for the admin-management UI. */
export async function listAdmins(): Promise<AdminListEntry[]> {
  const dynamic = await readAppAdmins().catch(() => [] as AppAdminRecord[]);
  const seen = new Set<string>();
  const out: AdminListEntry[] = [];
  for (const e of SEED_ADMINS) { out.push({ email: e, seed: true }); seen.add(e); }
  for (const a of dynamic) {
    if (seen.has(a.email)) continue; // a seed admin also present in the list — show once, as seed
    seen.add(a.email);
    out.push({ email: a.email, seed: false, addedByEmail: a.addedByEmail, addedAt: a.addedAt });
  }
  return out;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Add an admin to the dynamic list. Idempotent; validates the email. */
export async function addAdmin(email: string, byEmail: string): Promise<void> {
  const e = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new Error('Enter a valid email address.');
  if (SEED_ADMINS.includes(e)) return; // already a permanent admin
  const list = await readAppAdmins();
  if (list.some((a) => a.email === e)) return; // already present
  list.push({ email: e, addedByEmail: (byEmail || '').trim().toLowerCase(), addedAt: Date.now() });
  await writeAppAdmins(list);
  bustCache();
}

/** Remove an admin from the dynamic list. Seed admins cannot be removed. */
export async function removeAdmin(email: string): Promise<void> {
  const e = (email || '').trim().toLowerCase();
  if (SEED_ADMINS.includes(e)) throw new Error('Built-in admins cannot be removed.');
  const list = await readAppAdmins();
  await writeAppAdmins(list.filter((a) => a.email !== e));
  bustCache();
}
