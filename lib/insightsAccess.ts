/**
 * ResiWalk Insights access control.
 *
 * Insights-Only is a SEPARATE allowlist from app admins (stored on the HubSpot
 * Agent record as app_insights_users_json — see lib/hubspot readInsightsUsers/
 * writeInsightsUsers). Per the product decision, insights access is NOT
 * exclusive from admin:
 *
 *     canViewInsights(email) = isAppAdmin(email) || isInsightsUser(email)
 *
 * so app admins automatically have Insights access and never need to be added to
 * both lists. The Insights-Only list grants dashboard viewing ONLY — no admin
 * capabilities (managing users/admins, form builder, KB curation stay admin-only).
 *
 * Like adminAccess, the dynamic list is an async HubSpot read, so gating is async.
 */
import { isAppAdmin } from '@/lib/adminAccess';
import { readInsightsUsers, writeInsightsUsers, type InsightsUserRecord } from '@/lib/hubspot';

// Short cache so gating doesn't hit HubSpot on every request (mirrors adminAccess).
let _cache: { emails: Set<string>; at: number } | null = null;
const TTL_MS = 60_000;

async function insightsUserEmails(): Promise<Set<string>> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.emails;
  let emails = new Set<string>();
  try {
    const list = await readInsightsUsers();
    emails = new Set(list.map((u) => u.email.trim().toLowerCase()));
  } catch { /* best-effort: treat as empty */ }
  _cache = { emails, at: Date.now() };
  return emails;
}

function bustCache() { _cache = null; }

/** Is this user on the Insights-Only list? (Does NOT include admins — use canViewInsights for the gate.) */
export async function isInsightsUser(email: string | null | undefined): Promise<boolean> {
  const e = (email || '').trim().toLowerCase();
  if (!e) return false;
  return (await insightsUserEmails()).has(e);
}

/** THE gate for /insights: admins always qualify; Insights-Only users also qualify. */
export async function canViewInsights(email: string | null | undefined): Promise<boolean> {
  const e = (email || '').trim().toLowerCase();
  if (!e) return false;
  if (await isAppAdmin(e)) return true;
  return (await insightsUserEmails()).has(e);
}

export interface InsightsUserEntry {
  email: string;
  addedByEmail?: string;
  addedAt?: number;
}

/** The Insights-Only roster, for the management UI (admins are managed separately). */
export async function listInsightsUsers(): Promise<InsightsUserEntry[]> {
  const list = await readInsightsUsers().catch(() => [] as InsightsUserRecord[]);
  return list.map((u) => ({ email: u.email, addedByEmail: u.addedByEmail, addedAt: u.addedAt }));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Add an Insights-Only user. Idempotent; validates the email. Admins don't need to be added. */
export async function addInsightsUser(email: string, byEmail: string): Promise<void> {
  const e = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new Error('Enter a valid email address.');
  // Admins already have access via canViewInsights — adding one is harmless but pointless.
  if (await isAppAdmin(e)) return;
  const list = await readInsightsUsers();
  if (list.some((u) => u.email === e)) return; // already present
  list.push({ email: e, addedByEmail: (byEmail || '').trim().toLowerCase(), addedAt: Date.now() });
  await writeInsightsUsers(list);
  bustCache();
}

/** Remove an Insights-Only user from the list. */
export async function removeInsightsUser(email: string): Promise<void> {
  const e = (email || '').trim().toLowerCase();
  const list = await readInsightsUsers();
  await writeInsightsUsers(list.filter((u) => u.email !== e));
  bustCache();
}
