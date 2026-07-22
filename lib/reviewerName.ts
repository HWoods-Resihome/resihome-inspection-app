/**
 * Reviewer display name (server-only).
 *
 * Older service records stored the reviewer's EMAIL in `reviewed_by`, which then
 * showed verbatim to vendors ("Review: Approved · hwoods@resihome.com"). New
 * decisions store the session NAME, and this helper cleans up the historical
 * values at display time: an email resolves to the person's name via the login
 * activity map (which records a name per email), falling back to the email's
 * local part so a raw address is never shown.
 */
import { readLoginActivity } from '@/lib/loginActivity';

export async function reviewerDisplayName(value: string | null | undefined): Promise<string> {
  const s = String(value || '').trim();
  if (!s || !s.includes('@')) return s;   // already a name (or empty)
  try {
    const act = await readLoginActivity();
    const name = String(act?.[s.toLowerCase()]?.name || '').trim();
    if (name) return name;
  } catch { /* fall through */ }
  return s.split('@')[0];
}
